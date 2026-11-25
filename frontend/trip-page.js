/**
 * TravelMate - trip page (/trip?id=N): the whole trip in full width, by tabs.
 *   📅 Days            day-by-day plan: driving, places on the way, stops, nights
 *   💶 Budget          shared TripBudget block (fuel by country when a car is set)
 *   🚗 Car & fuel      car of the trip, km per country x fuel price per country
 *   🤖 AI              shared AIReview block (review + proposed changes)
 * The route itself is edited on the map (/map#route=N&open); changes here are saved automatically.
 */
(function () {
    const routeId = parseInt(new URLSearchParams(location.search).get('id'), 10);
    const $ = (id) => document.getElementById(id);

    async function api(method, path, body, timeoutMs = 60000) {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), timeoutMs);
        try {
            const r = await fetch(`${window.CONFIG.API_BASE_URL}${path}`, {
                method, signal: ctrl.signal,
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${localStorage.getItem('token')}` },
                body: body ? JSON.stringify(body) : undefined,
            });
            if (r.status === 401) { location.href = '/map'; throw new Error('not signed in'); }
            const j = r.status === 204 ? null : await r.json().catch(() => null);
            if (!r.ok) {
                const err = new Error((j && (typeof j.detail === 'string' ? j.detail : JSON.stringify(j.detail))) || `HTTP ${r.status}`);
                err.status = r.status;
                throw err;
            }
            return j;
        } finally { clearTimeout(t); }
    }
    const qs = (q) => (q ? '?' + new URLSearchParams(q) : '');

    // the shared blocks (TripBudget, AIReview) expect window.app and window.routePlanner
    window.app = {
        currentUser: true,
        api: { get: (p, q) => api('GET', p + qs(q)), post: (p, b) => api('POST', p, b), put: (p, b) => api('PUT', p, b) },
        showStatus(msg, type = 'info') {
            let el = $('tripToast');
            if (!el) { el = document.createElement('div'); el.id = 'tripToast'; el.className = 'trip-toast'; document.body.appendChild(el); }
            el.textContent = msg;
            el.className = `trip-toast ${type}`;
            el.style.display = 'block';
            clearTimeout(this._t);
            this._t = setTimeout(() => { el.style.display = 'none'; }, 4000);
        },
        errorHandler: { handle(e, ctx) { window.app.showStatus(`${ctx}: ${e.message || e}`, 'error'); } },
    };

    const TP = {
        isTripPage: true,
        route: null, stops: [], budget: { ...BUDGET_DEFAULTS, extras: [] }, carId: null,
        lastPlan: null, loadedRouteId: routeId, fuelEstimate: null, fuelPlan: null, carLabel: '', cars: [], ready: false,

        dayPlan() { return computeDayPlan(this.stops, this.route?.start_date); },
        payload() { return stopsPayload(this.stops); },
        budgetPayload() { return budgetPayload(this.budget, this.carId); },
        render() { renderDays(); this.renderSummary(); scheduleSave(); },
        renderSummary() { window.TripBudget?.render(this); window.AIReview?.render(this); },
        saveDraft() { scheduleSave(); },
        refreshMarkers() { /* no map on this page */ },
        async calculate() { await plan(); await refreshFuel(); renderDays(); this.renderSummary(); },
        // settings saved before v2 meant "start with a full tank that is not counted" - replaced by the new defaults
        fuelSettings() {
            const fs = this.budget.fuel_settings;
            return fs && fs.v === 2 ? { ...BUDGET_DEFAULTS.fuel_settings, ...fs } : { ...BUDGET_DEFAULTS.fuel_settings };
        },
    };
    window.routePlanner = TP;

    // ---------- load / save ----------

    async function load() {
        const r = await api('GET', `/routes/${routeId}?_=${Date.now()}`);
        TP.route = r;
        TP.stops = r.waypoints.map(w => ({ name: w.name, lat: w.latitude, lng: w.longitude, marker: null,
            legMode: w.leg_mode || 'road', legHours: w.leg_hours ?? null, legDate: w.leg_date ?? null, ...stopFromApi(w) }));
        TP.budget = { ...BUDGET_DEFAULTS };
        Object.keys(BUDGET_DEFAULTS).forEach(k => { if (r[k] !== null && r[k] !== undefined) TP.budget[k] = r[k]; });
        TP.budget.extras = Array.isArray(r.extras) ? r.extras : [];
        TP.carId = r.car_id ?? null;
        TP.role = r.my_role || 'owner';
        TP.readOnly = TP.role === 'viewer';
        TP.version = r.version || 1;
        document.body.classList.toggle('trip-readonly', TP.readOnly);
        $('routeName').value = r.name || '';
        $('routeStartDate').value = r.start_date || '';
        $('editOnMap').href = `/map#route=${r.id}&open`;
        document.title = `TravelMate - ${r.name}`;
    }

    let saveTimer = null;
    function scheduleSave() {
        if (!TP.ready || TP.readOnly || TP.conflict) return;
        setSaveState('unsaved');
        clearTimeout(saveTimer);
        saveTimer = setTimeout(save, 800);
    }

    async function save() {
        setSaveState('saving');
        try {
            const saved = await api('PUT', `/routes/${routeId}`, {
                name: TP.route.name, description: TP.route.description, start_date: TP.route.start_date,
                waypoints: TP.payload(), ...TP.budgetPayload(), version: TP.version,
            });
            TP.version = saved.version;
            setSaveState('saved');
        } catch (e) {
            if (e.status === 409) {           // someone else saved since we loaded: never overwrite silently
                TP.conflict = true;
                setSaveState('error', 'conflict');
                showChangedBanner(e.message, true);
            } else {
                setSaveState('error', e.message);
            }
        }
    }

    // ---------- sharing: others' changes, people ----------

    function showChangedBanner(text, conflict) {
        let el = $('changedBanner');
        if (!el) {
            el = document.createElement('div');
            el.id = 'changedBanner';
            el.className = 'trip-changed';
            document.querySelector('.trip-head-bar').after(el);
        }
        el.innerHTML = `<span>${escapeHtml(text)}${conflict ? ' Your last change was not saved.' : ''}</span>
            <button class="btn btn-primary btn-sm" onclick="location.reload()">Reload</button>`;
    }

    // every 30 s: has someone else saved the trip? (only for shared trips)
    function watchChanges() {
        setInterval(async () => {
            if (document.hidden || TP.conflict || !(TP.role !== 'owner' || TP.route.shared_count)) return;
            try {
                const v = await api('GET', `/sharing/routes/${routeId}/version`);
                if (v.version > TP.version && !v.updated_by_me) {
                    TP.conflict = !TP.readOnly;       // stop autosaving on top of their changes
                    showChangedBanner(`${v.updated_by_name || 'Someone'} has changed this trip.`, false);
                }
            } catch (e) { /* offline: try next time */ }
        }, 30000);
    }

    function renderShareHead() {
        const box = $('shareHead');
        if (!box) return;
        if (TP.role === 'owner') {
            box.innerHTML = `<button class="btn btn-outline btn-sm" onclick="TripPage.shareOpen()"><i class="fas fa-user-plus"></i>
                Share${TP.route.shared_count ? ` · ${TP.route.shared_count}` : ''}</button>`;
        } else {
            box.innerHTML = `<span class="share-badge" title="Shared with you by ${escAttr(TP.route.owner_name || '')}">
                👥 ${escapeHtml(TP.route.owner_name || 'Owner')}'s trip · ${TP.readOnly ? 'view only' : 'you can edit'}</span>
                <button class="btn btn-outline btn-sm" onclick="TripPage.shareOpen()">People</button>`;
        }
        if (TP.readOnly) $('editOnMap').innerHTML = '<i class="fas fa-map"></i> View on map';
    }

    async function shareOpen() {
        const box = $('sharePanel');
        box.hidden = false;
        box.innerHTML = '<div class="tb-note">Loading…</div>';
        try {
            const d = await api('GET', `/sharing/routes/${routeId}/members`);
            const owner = d.my_role === 'owner';
            const st = { pending: '⏳ invited', accepted: '✓', declined: '✗ declined', expired: '⌛ invitation expired' };
            const rows = d.members.map(m => `<div class="share-row">
                    <div><b>${escapeHtml(m.name)}</b> ${m.email ? `<small>${escapeHtml(m.email)}</small>` : ''}
                        <span class="share-status ${escAttr(m.status)}">${st[m.status] || ''}</span></div>
                    ${owner ? `<div class="share-row-act">
                        <select onchange="TripPage.shareRole(${m.id}, this.value)">
                            <option value="editor" ${m.role === 'editor' ? 'selected' : ''}>can edit</option>
                            <option value="viewer" ${m.role === 'viewer' ? 'selected' : ''}>view only</option></select>
                        <button class="wp-link" onclick="TripPage.shareRemove(${m.id})" title="Remove">✕</button></div>`
                        : `<span class="tb-note">${m.role === 'editor' ? 'can edit' : 'view only'}</span>`}
                </div>`).join('');
            box.innerHTML = `<div class="share-head"><h3>People in this trip</h3><button class="wp-link" onclick="TripPage.shareClose()">✕</button></div>
                <div class="share-row"><div><b>${escapeHtml(d.owner.name)}</b> ${d.owner.email ? `<small>${escapeHtml(d.owner.email)}</small>` : ''}</div><span class="tb-note">owner</span></div>
                ${rows || '<div class="tb-note">Nobody else yet.</div>'}
                ${owner ? `<form class="share-form" onsubmit="event.preventDefault(); TripPage.shareInvite(this)">
                    <input type="email" name="email" class="form-input" placeholder="Email of their TravelMate account" required>
                    <select name="role" class="form-input"><option value="editor">can edit</option><option value="viewer">view only</option></select>
                    <button class="btn btn-primary btn-sm" type="submit">Invite</button>
                    </form>
                    <div class="tb-note">The trip appears in their account only after they accept the invitation (it expires in 14 days).
                        Editors change stops, bookings and budget; only you can delete the trip or manage people.</div>`
                  : `<button class="btn btn-outline btn-sm" onclick="TripPage.shareLeave()">Leave this trip</button>`}`;
        } catch (e) {
            box.innerHTML = `<div class="ferry-msg err">${escapeHtml(e.message)}</div>`;
        }
    }

    async function shareInvite(form) {
        try {
            await api('POST', `/sharing/routes/${routeId}/members`, { email: form.email.value.trim(), role: form.role.value });
            window.app.showStatus('Invitation sent', 'success');
            TP.route.shared_count = (TP.route.shared_count || 0) + 1;
            renderShareHead();
            shareOpen();
        } catch (e) { window.app.showStatus(e.message, 'error'); }
    }

    async function shareRole(id, role) {
        try { await api('PATCH', `/sharing/routes/${routeId}/members/${id}`, { role }); window.app.showStatus('Saved', 'success'); }
        catch (e) { window.app.showStatus(e.message, 'error'); shareOpen(); }
    }

    async function shareRemove(id) {
        if (!confirm('Remove this person from the trip?')) return;
        try {
            await api('DELETE', `/sharing/routes/${routeId}/members/${id}`);
            TP.route.shared_count = Math.max(0, (TP.route.shared_count || 1) - 1);
            renderShareHead();
            shareOpen();
        } catch (e) { window.app.showStatus(e.message, 'error'); }
    }

    async function shareLeave() {
        if (!confirm('Leave this trip? It will disappear from your trips.')) return;
        try { await api('POST', `/sharing/routes/${routeId}/leave`); location.href = '/trips'; }
        catch (e) { window.app.showStatus(e.message, 'error'); }
    }

    function setSaveState(s, msg) {
        const el = $('saveState');
        el.className = `save-state ${s}`;
        el.textContent = { unsaved: '● unsaved', saving: 'saving…', saved: '✓ saved', error: `⚠ not saved: ${msg || ''}` }[s] || '';
    }

    async function plan() {
        try {
            TP.lastPlan = await api('POST', '/routes/plan', { waypoints: TP.payload(), profile: 'driving' }, 90000);
        } catch (e) {
            TP.lastPlan = null;
            window.app.showStatus(`Route could not be calculated: ${e.message}`, 'error');
        }
    }

    // ---------- header ----------

    function renderHead() {
        const r = TP.route, days = TP.dayPlan();
        const nights = TP.stops.reduce((a, s) => a + (s.stopType === 'overnight' ? (s.nights || 1) : 0), 0);
        $('tripTitle').textContent = r.name;
        const fmt = (d) => d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
        let dates = 'no start date';
        if (r.start_date) {
            const s = new Date(r.start_date + 'T12:00:00'); const e = new Date(s); e.setDate(e.getDate() + nights);
            dates = nights ? `${fmt(s)} – ${fmt(e)}` : fmt(s);
        }
        const p = TP.lastPlan;
        $('tripMeta').innerHTML = `${escapeHtml(dates)} · ${days.totalDays} day${days.totalDays > 1 ? 's' : ''} · ${TP.stops.length} stops`
            + (p ? ` · ${Formatter.distance(p.distance_km)} · ${Formatter.duration(p.duration_minutes)} on the move` : '');
    }

    // ---------- 📅 days ----------

    function renderDays() {
        renderHead();
        const box = $('daysView');
        const stops = TP.stops, legs = TP.lastPlan?.legs || [], days = TP.dayPlan();
        const n = stops.length;
        const short = (s) => escapeHtml(String(s.name).split(',')[0]);
        const icon = { road: '🚗', ferry: '⛴', flight: '✈' };
        const dateOf = (d) => days.fmt(d);
        // a day = from the start / an overnight stop to the next overnight stop (or the end)
        const sections = [];
        let a = 0;
        for (let i = 1; i < n; i++) if (stops[i].stopType === 'overnight' || i === n - 1) { sections.push([a, i]); a = i; }
        const spotList = (list) => (list || []).map(p => `<li>${p.url ? `<a href="${escAttr(p.url)}" target="_blank" rel="noopener">${escapeHtml(p.name)}</a>` : escapeHtml(p.name)}${p.detour_min ? ` <small>+${p.detour_min} min</small>` : ''}${p.cost ? ` <small>· ${p.cost} ${escapeHtml(p.currency || '')}</small>` : ''}</li>`).join('');
        const refuels = refuelsByLeg();
        // weather: on the day we are there (a stop we leave in the morning: the day we leave); filled in after render
        const wxPoints = [];
        const wxSlot = (i, leaving) => {
            const date = stopDate(stops, i, TP.route?.start_date, leaving);
            if (!Weather.usable(date)) return '';
            wxPoints.push({ lat: stops[i].lat, lng: stops[i].lng, date });
            return `<span class="dv-wx" data-wx="${escAttr(Weather.key(stops[i].lat, stops[i].lng, date))}"></span>`;
        };
        const html = sections.map(([from, to]) => {
            const depart = days.dayOf[from] + (stops[from].stopType === 'overnight' ? (stops[from].nights || 1) : 0);
            let km = 0, min = 0, detour = 0;
            for (let i = from; i < to; i++) { km += legs[i]?.distance_km || 0; min += legs[i]?.duration_minutes || 0; (stops[i].legSpots || []).forEach(p => { detour += p.detour_min || 0; }); }
            const rows = [];
            for (let i = from; i <= to; i++) {
                const s = stops[i];
                if (i > from) {
                    const prev = stops[i - 1], l = legs[i - 1];
                    rows.push(`<div class="dv-leg">${icon[prev.legMode || 'road']} ${l ? `${Formatter.distance(l.distance_km)} · ${Formatter.duration(l.duration_minutes)}` : ''}
                        ${prev.legMode !== 'road' && prev.legMode ? `${prev.legDate ? ' · ' + escapeHtml(prev.legDate) : ''}${prev.legBooked ? ' · ✅ booked' : ' · not booked'}` : ''}
                        ${(prev.legSpots || []).length ? `<ul class="dv-onway">${spotList(prev.legSpots)}</ul>` : ''}
                        ${(refuels[i - 1] || []).map(st => `<div class="dv-refuel">⛽ ${escapeHtml(TP.fuelPlan.names[st.cc] || st.cc)}: fill ${st.litres} L · ${Math.round(st.cost)} € <small>(~10 min)</small></div>`).join('')}</div>`);
                }
                const role = i === from ? (from === 0 ? 'start' : 'leave') : (i === to ? (s.stopType === 'overnight' ? 'sleep' : 'arrive') : s.stopType);
                const roleIcon = { start: '🏁', leave: '🌅', sleep: '🛏', arrive: '🏁', visit: '📍', pass: '🔁' }[role] || '📍';
                const showSpots = i !== from || from === 0;  // spots of an overnight stop are listed on the day we arrive
                rows.push(`<div class="dv-stop">
                    <div class="dv-stop-head">${roleIcon} <b>${short(s)}</b> <small>${i + 1}</small>${wxSlot(i, role === 'leave')}</div>
                    ${showSpots && (s.spots || []).length ? `<ul class="dv-spots">${spotList(s.spots)}</ul>` : ''}
                    ${i === to && s.stopType === 'overnight' ? `<div class="dv-lodging">${s.nights || 1} night${(s.nights || 1) > 1 ? 's' : ''}
                        ${s.lodgingName ? ' · ' + escapeHtml(s.lodgingName) : ' · lodging not set'}
                        ${s.lodgingPrice ? ` · ${s.lodgingPrice} ${escapeHtml(s.lodgingCurrency || '')}` : ''}
                        · ${s.lodgingBooked ? '✅ booked' : `⏳ not booked · <a class="dv-find" href="${escAttr(bookingSearchUrl(String(s.name).split(',').slice(0, 2).join(','), stayDates(stops, i, TP.route.start_date)))}" target="_blank" rel="noopener">find on Booking.com ↗</a>`}
                        ${/^https?:\/\//i.test(s.lodgingUrl || '') ? ` · <a href="${escAttr(s.lodgingUrl)}" target="_blank" rel="noopener">booking ↗</a>` : ''}
                        ${(s.nights || 1) > 1 ? `<div class="dv-free">🏖 free day${(s.nights || 1) > 2 ? 's' : ''} in ${short(s)}: ${escapeHtml(dateOf(days.dayOf[i] + 1))}${(s.nights || 1) > 2 ? ` … ${escapeHtml(dateOf(days.dayOf[i] + (s.nights || 1) - 1))}` : ''}</div>` : ''}</div>` : ''}
                </div>`);
            }
            return `<div class="dv-day">
                <div class="dv-day-head"><span class="dv-date">${escapeHtml(dateOf(depart))}</span>
                    <span class="dv-route">${short(stops[from])} → ${short(stops[to])}</span>
                    <span class="dv-stats">${legs.length ? `🚗 ${Formatter.distance(km)} · ${Formatter.duration(min)}${detour ? ` · +${detour} min for places` : ''}` : ''}</span></div>
                ${rows.join('')}
            </div>`;
        }).join('');
        box.innerHTML = (html || '<div class="pp-empty">This trip has fewer than 2 stops.</div>')
            + (wxPoints.length ? `<div class="dv-wx-attr">🌤 Within 16 days: forecast; later: usual weather for these dates (average of the last 10 years). 🌊 sea surface temperature at the coast. ${Weather.ATTR}</div>` : '');
        fillWeather(box, wxPoints);
    }

    async function fillWeather(box, points) {
        if (!points.length) return;
        const res = await Weather.many(points);
        points.forEach((p, k) => {
            if (!res[k]) return;
            box.querySelectorAll(`[data-wx="${CSS.escape(Weather.key(p.lat, p.lng, p.date))}"]`)
               .forEach(el => { el.innerHTML = Weather.html(res[k], { compact: true }); });
        });
    }

    // ---------- 🚗 car & fuel ----------

    function car() {
        return TP.cars.find(c => c.id === TP.carId)
            || (TP.role !== 'owner' && TP.route?.car && TP.route.car.id === TP.carId ? TP.route.car : null);
    }

    function renderCarSelect() {
        const sel = $('tripCar');
        if (TP.role !== 'owner') {          // the car is the owner's: shown, not changeable
            const c = car();
            sel.innerHTML = `<option>${c ? escapeHtml(CarsUI.label(c)) : '— no car —'}</option>`;
            sel.disabled = true;
            return;
        }
        sel.innerHTML = `<option value="">— no car (one average fuel price in the budget) —</option>`
            + TP.cars.map(c => `<option value="${c.id}" ${c.id === TP.carId ? 'selected' : ''}>${escapeHtml(CarsUI.label(c))}</option>`).join('');
    }

    function roadLines() {
        const p = TP.lastPlan;
        if (!p) return [];
        const segs = (p.segments && p.segments.length) ? p.segments.filter(s => s.mode === 'road').map(s => s.coordinates)
                                                       : [p.geometry?.coordinates || []];
        // thin out to ~every 500 m: enough to tell countries apart, small request
        return segs.map(line => {
            const out = [];
            let last = null;
            line.forEach((pt, k) => {
                if (!last || k === line.length - 1 || Math.abs(pt[0] - last[0]) + Math.abs(pt[1] - last[1]) > 0.005) { out.push(pt); last = pt; }
            });
            return out;
        }).filter(l => l.length > 1);
    }

    async function refreshFuel() {
        const c = car();
        TP.carLabel = c ? CarsUI.label(c) : '';
        if (!c || !c.consumption || !TP.lastPlan) {
            TP.fuelEstimate = null;
            $('fuelBox').innerHTML = !c ? 'Pick a car to see fuel per country.'
                : (!c.consumption ? 'Enter the consumption of this car.' : 'Route not calculated.');
            return;
        }
        $('fuelBox').innerHTML = '<div class="tb-note">Calculating km per country…</div>';
        try {
            TP.fuelEstimate = await api('POST', '/fuel/estimate', { lines: roadLines(), fuel_type: c.fuel_type, consumption: c.consumption });
            renderFuel();
        } catch (e) {
            TP.fuelEstimate = null;
            $('fuelBox').innerHTML = `<div class="ferry-msg err">Fuel estimate failed: ${escapeHtml(e.message)}</div>`;
        }
        await refreshRefuelPlan();
    }

    // ---------- ⛽ refuel plan ----------

    async function refreshRefuelPlan() {
        const c = car();
        TP.fuelPlan = null;
        if (!c || !c.consumption || !TP.lastPlan) { $('refuelBox').innerHTML = 'Pick a car with consumption and tank size.'; return; }
        if (!c.tank_l) { $('refuelBox').innerHTML = settingsHtml() + '<div class="ai-warn">Enter the tank size of the car (My cars → Edit).</div>'; return; }
        const fs = TP.fuelSettings();
        $('refuelBox').innerHTML = settingsHtml() + '<div class="tb-note">Planning refuels…</div>';
        try {
            TP.fuelPlan = await api('POST', '/fuel/plan', { lines: roadLines(), fuel_type: c.fuel_type, consumption: c.consumption,
                tank_l: c.tank_l, start_pct: fs.start_pct, reserve_pct: fs.reserve_pct, end: fs.end });
            renderRefuelPlan();
        } catch (e) {
            $('refuelBox').innerHTML = settingsHtml() + `<div class="ferry-msg err">Refuel plan failed: ${escapeHtml(e.message)}</div>`;
        }
    }

    function settingsHtml() {
        const fs = TP.fuelSettings();
        return `<div class="tb-prefs">
            <label title="Fuel you already have when leaving - not counted in the budget">already in the tank <select onchange="TripPage.fuelSetting('start_pct', this.value)">${[0, 25, 50, 75, 100].map(v => `<option value="${v}" ${v === +fs.start_pct ? 'selected' : ''}>${v === 0 ? 'only the reserve (count all fuel)' : v === 100 ? 'full (not counted)' : v + ' % (not counted)'}</option>`).join('')}</select></label>
            <label>reserve <select onchange="TripPage.fuelSetting('reserve_pct', this.value)">${[10, 15, 20, 25].map(v => `<option value="${v}" ${v === +fs.reserve_pct ? 'selected' : ''}>${v} %</option>`).join('')}</select></label>
            <label>at the end <select onchange="TripPage.fuelSetting('end', this.value)">
                ${[['empty', "don't care"], ['same', 'as at start'], ['full', 'full']].map(([v, l]) => `<option value="${v}" ${v === fs.end ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
        </div>`;
    }

    function fuelSetting(k, v) {
        TP.budget.fuel_settings = { ...TP.fuelSettings(), v: 2, [k]: k === 'end' ? v : parseFloat(v) };
        scheduleSave();
        refreshRefuelPlan().then(() => { renderDays(); TP.renderSummary(); });
    }

    function whyText(st, fp) {
        const n = (cc) => escapeHtml(fp.names[cc] || cc);
        const eur = (v) => `${(+v).toFixed(2)} €`;
        switch (st.why) {
            case 'fill': return st.next_cc ? `fill up — ${n(st.next_cc)} next: ${eur(st.next_price)}/L` : 'fill up — nothing cheaper within range';
            case 'to_cheaper': return `just enough to reach ${n(st.target.cc)} (${eur(st.target.price)}/L)`;
            case 'to_end': return 'enough to finish the trip';
            case 'low': return 'tank low, nothing cheaper within range';
            case 'end': return 'back to the start level at the end (counted for a fair total)';
            default: return '';
        }
    }

    function renderRefuelPlan() {
        const fp = TP.fuelPlan;
        if (!fp) return;
        const name = (cc) => escapeHtml(fp.names[cc] || cc);
        const priceTxt = (cc) => {
            const p = fp.prices[cc];
            if (!p) return '<span class="ai-warn">no price</span>';
            return p.currency === 'EUR' ? `${p.price.toFixed(3)} €` : `${p.price} ${escapeHtml(p.currency)}${p.price_eur ? ` (${p.price_eur.toFixed(2)} €)` : ''}`;
        };
        $('refuelBox').innerHTML = settingsHtml() + `
            <div class="rf-sum"><b>${Math.round(fp.cost_eur)} €</b> with this plan · ${Math.round(fp.naive_cost_eur)} € filling up whenever the tank is low
                · <span class="rf-save">saving ${Math.round(fp.saving_eur)} €</span></div>
            ${fp.missing.length ? `<div class="ai-warn">No price for ${fp.missing.map(name).join(', ')} — enter it in the table above (assumed as the most expensive country meanwhile).</div>` : ''}
            ${fp.warnings.length ? `<div class="ai-warn">${escapeHtml(fp.warnings.join('; '))}</div>` : ''}
            <table class="fuel-table">
                <tr><th>km</th><th>Where</th><th>Fill</th><th>Price</th><th>Cost</th><th>Why</th></tr>
                ${fp.stops.map(st => `<tr>
                    <td>${Math.round(st.km)}</td>
                    <td>${st.km < 1 ? '🏁 ' : ''}${name(st.cc)}${st.km < 1 ? ' — before leaving' : ''}${st.pt ? ` · <a href="https://www.google.com/maps/search/gas+station/@${st.pt[1]},${st.pt[0]},12z" target="_blank" rel="noopener" title="Fuel stations around this point">stations ↗</a>` : ''}</td>
                    <td>${st.litres} L</td><td>${priceTxt(st.cc)}</td><td>${Math.round(st.cost)} €</td>
                    <td class="rf-why">${whyText(st, fp)}</td></tr>`).join('')}
            </table>
            <div class="tb-note">The place of a fill-up is approximate (by country, “before the border” = last ~50 km in that country).
                Prices are national averages: motorway stations are often 10–20 cents dearer. Ferries and flights use no fuel; the tank is carried over.</div>`;
    }

    // road km of the plan -> index of the leg (for the Days tab)
    function refuelsByLeg() {
        const out = {};
        const fp = TP.fuelPlan, legs = TP.lastPlan?.legs || [];
        if (!fp) return out;
        let acc = 0;
        const ranges = legs.map((l, i) => {
            const road = (TP.stops[i].legMode || 'road') === 'road';
            const r = { i, from: acc, to: acc + (road ? l.distance_km : 0), road };
            acc = r.to;
            return r;
        });
        fp.stops.filter(st => st.why !== 'end').forEach(st => {
            const r = ranges.find(x => x.road && st.km >= x.from - 0.5 && st.km <= x.to + 0.5) || ranges.filter(x => x.road).slice(-1)[0];
            if (r) (out[r.i] = out[r.i] || []).push(st);
        });
        return out;
    }

    function renderFuel() {
        const fe = TP.fuelEstimate;
        if (!fe) return;
        const unit = fe.fuel === 'electric' ? 'kWh' : 'L';
        const src = (r) => r.source === 'eu_bulletin' ? `EU bulletin, ${escapeHtml(r.date || '')}`
            : r.source === 'manual' ? `your price, ${escapeHtml(r.date || '')}` : '<span class="ai-warn">no price</span>';
        const totals = {};
        fe.countries.forEach(r => { if (r.cost != null) totals[r.currency] = (totals[r.currency] || 0) + r.cost; });
        $('fuelBox').innerHTML = `
            <table class="fuel-table">
                <tr><th>Country</th><th>km</th><th>${unit}</th><th>Price / ${unit}</th><th>Source</th><th>Cost</th></tr>
                ${fe.countries.map(r => `<tr>
                    <td>${r.country === '??' ? '🌊 sea / outside map' : `${escapeHtml(r.name)} <small>${escapeHtml(r.country)}</small>`}</td>
                    <td>${Math.round(r.km)}</td><td>${r.amount}</td>
                    <td>${r.source === 'eu_bulletin' ? `${r.price.toFixed(3)} EUR`
                        : (r.country === '??' ? '—' : `<span class="fuel-manual"><input class="tb-num" inputmode="decimal" value="${r.price ?? ''}" placeholder="price" data-cc="${escAttr(r.country)}">
                           <select data-cur="${escAttr(r.country)}">${currencyOptions(r.currency || 'EUR')}</select>
                           <button class="wp-link" onclick="TripPage.savePrice('${escAttr(r.country)}')">save</button></span>`)}</td>
                    <td>${r.country === '??' ? '' : src(r)}</td>
                    <td>${r.cost != null ? `${Math.round(r.cost).toLocaleString()} ${escapeHtml(r.currency)}` : '—'}</td></tr>`).join('')}
                <tr class="tb-total"><td>Total</td><td>${Math.round(fe.total_km)}</td><td>${fe.countries.reduce((a, r) => a + r.amount, 0).toFixed(1)}</td><td></td><td></td>
                    <td>${Object.entries(totals).map(([c, v]) => `${Math.round(v).toLocaleString()} ${escapeHtml(c)}`).join(' + ') || '—'}</td></tr>
            </table>
            <div class="tb-note">Consumption ${fe.consumption} ${unit}/100 km × road km in each country. EU prices: weekly national averages
                (<a href="${escAttr(fe.attribution.url)}" target="_blank" rel="noopener">${escapeHtml(fe.attribution.text)}</a>).
                Other countries: enter the price once, it is kept for your next trips. Ferries and flights are not counted.</div>`;
    }

    async function savePrice(cc) {
        const inp = document.querySelector(`#fuelBox input[data-cc="${cc}"]`);
        const cur = document.querySelector(`#fuelBox select[data-cur="${cc}"]`);
        const price = parseFloat(String(inp?.value || '').replace(',', '.'));
        if (!(price > 0)) { window.app.showStatus('Enter a price', 'error'); return; }
        const fuel = TP.fuelEstimate?.fuel || 'petrol';
        try {
            await api('PUT', '/fuel/prices', { country: cc, fuel, price, currency: cur?.value || 'EUR' });
            await refreshFuel();
            TP.renderSummary();
            window.app.showStatus(`Price for ${cc} saved`, 'success');
        } catch (e) {
            window.app.showStatus(`Could not save: ${e.message}`, 'error');
        }
    }

    async function onCarChange(id) {
        TP.carId = id ? parseInt(id, 10) : null;
        scheduleSave();
        await refreshFuel();
        TP.renderSummary();
    }

    // ---------- tabs / init ----------

    function showTab(name) {
        document.querySelectorAll('.trip-tab').forEach(b => b.classList.toggle('active', b.dataset.tab === name));
        document.querySelectorAll('.trip-panel').forEach(p => { p.hidden = p.id !== `tab-${name}`; });
        try { history.replaceState(null, '', `${location.pathname}${location.search}#${name}`); } catch (e) { /* ignore */ }
    }

    // ---------- stop names in one language ----------

    let renameRun = 0;
    async function renameStart() {
        const lang = placeLang();
        if (lang === 'local') { window.app.showStatus('Place names language is “local” — change it in your Profile', 'info'); return; }
        const run = ++renameRun;
        const box = $('renameBox');
        const rows = [];
        box.innerHTML = `<div class="rn-box"><div class="tb-note">Looking up names in ${escapeHtml(PLACE_LANGS[lang] || lang)}… 0/${TP.stops.length}
            (OpenStreetMap allows ~1 request per second)</div></div>`;
        for (let i = 0; i < TP.stops.length; i++) {
            if (run !== renameRun) return;
            const s = TP.stops[i];
            let res = null;
            try { res = await api('GET', `/locations/reverse${qs({ lat: s.lat, lon: s.lng, lang })}`); } catch (e) { /* skip */ }
            const nn = res && res.name && !/^-?\d/.test(res.name) ? res.name : null;
            rows.push({ i, old: s.name, new: nn, pick: !!nn && nn !== s.name });
            const note = box.querySelector('.tb-note');
            if (note) note.textContent = `Looking up names… ${i + 1}/${TP.stops.length}`;
        }
        TripPage._rename = rows;
        const changes = rows.filter(r => r.new && r.new !== r.old);
        box.innerHTML = `<div class="rn-box">
            ${changes.length ? `<div class="tb-sub">Rename ${changes.length} stop${changes.length > 1 ? 's' : ''} to ${escapeHtml(PLACE_LANGS[lang] || lang)}:</div>
                ${changes.map(r => `<label class="rn-row"><input type="checkbox" checked onchange="TripPage._rename[${rows.indexOf(r)}].pick = this.checked">
                    <span class="rn-old">${escapeHtml(r.old)}</span> → <b>${escapeHtml(r.new)}</b></label>`).join('')}
                <div class="on-row"><button class="btn btn-primary btn-sm" onclick="TripPage.renameApply()">Rename</button>
                    <button class="wp-link" onclick="document.getElementById('renameBox').innerHTML=''">Cancel</button></div>
                <div class="tb-note">Untick names you typed yourself and want to keep.</div>`
              : '<div class="tb-note">All names are already fine.</div>'}</div>`;
    }

    function renameApply() {
        (TripPage._rename || []).forEach(r => { if (r.pick && r.new) TP.stops[r.i].name = r.new; });
        $('renameBox').innerHTML = '';
        TP.render();
        window.app.showStatus('Stops renamed', 'success');
    }

    window.TripPage = { savePrice, showTab, fuelSetting, renameStart, renameApply,
        shareOpen, shareInvite, shareRole, shareRemove, shareLeave, shareClose: () => { $('sharePanel').hidden = true; } };
    window.logout = () => { localStorage.removeItem('token'); location.href = '/map'; };

    document.addEventListener('DOMContentLoaded', async () => {
        document.querySelectorAll('.trip-tab').forEach(b => b.addEventListener('click', () => showTab(b.dataset.tab)));
        $('tripCar').addEventListener('change', (e) => onCarChange(e.target.value));
        $('renameBtn').textContent = placeLang() === 'local' ? '' : `🔤 Names in ${PLACE_LANGS[placeLang()] || placeLang()}`;
        window.addEventListener('bookingprefs', () => { if (TP.route) renderDays(); });
        if (!routeId) { $('tripTitle').textContent = 'No trip selected'; return; }
        try {
            const me = await api('GET', '/auth/me').catch(() => null);
            if (me && $('userName')) $('userName').textContent = me.name;
            await load();
            TripBudget.open = true;
            AIReview.open = true;
            await CarsUI.mount($('carsBox'), { onChange: async (cars) => { TP.cars = cars; renderCarSelect(); await refreshFuel(); TP.renderSummary(); } });
            TP.cars = CarsUI.cars;
            renderCarSelect();
            renderDays();
            TP.renderSummary();
            await plan();
            await refreshFuel();
            renderDays();
            TP.renderSummary();
            TP.ready = true;
            renderShareHead();
            watchChanges();
            const tab = location.hash.slice(1);
            if (['days', 'budget', 'car', 'ai'].includes(tab)) showTab(tab);
        } catch (e) {
            $('tripTitle').textContent = 'Could not load the trip';
            $('tripMeta').textContent = e.message;
        }
    });
})();
