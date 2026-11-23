/**
 * TravelMate - "🤖 AI review": Claude looks at the whole trip (days, driving per day, ferries,
 * nights, places, budget) and the traveller's wishes, and answers with a score, risks and
 * concrete changes. Backend: POST /routes/ai-review (key in backend/.env).
 */
const AIReview = {
    open: false,
    busy: false,
    result: null,     // last answer {review, model, input_tokens, output_tokens}
    error: null,
    WISHES_KEY: 'travelmate_ai_wishes',
    edit: null,        // last proposal {summary, changes[]} with .picked flags
    editBusy: false,
    editError: null,
    editRequest: '',

    el() { return document.getElementById('aiReview'); },

    wishes() {
        try { return localStorage.getItem(this.WISHES_KEY) || ''; } catch (e) { return ''; }
    },

    saveWishes(v) {
        try { localStorage.setItem(this.WISHES_KEY, v); } catch (e) { /* ignore */ }
    },

    // trip + weather on the day at each stop (forecast or usual for these dates); never blocks the request for long
    async tripWithWeather(rp) {
        const trip = this.tripJson(rp);
        if (!window.Weather) return trip;
        const pts = trip.stops.map((s, i) => ({ s, lat: rp.stops[i].lat, lng: rp.stops[i].lng, date: s.date }))
            .filter(p => Weather.usable(p.date) && (p.s.type !== 'pass' || p.s.n === 1 || p.s.n === trip.stops.length)).slice(0, 40);
        if (!pts.length) return trip;
        const res = await Promise.race([Weather.many(pts), new Promise(r => setTimeout(() => r(null), 15000))]);
        if (res) pts.forEach((p, k) => { const w = Weather.text(res[k]); if (w) p.s.weather = w; });
        return trip;
    },

    // compact, model-friendly description of the trip
    tripJson(rp) {
        const days = rp.dayPlan();
        const legs = rp.lastPlan?.legs || [];
        const start = document.getElementById('routeStartDate')?.value || null;
        const dateOf = (day) => {
            if (!start) return null;
            const d = new Date(start + 'T12:00:00');
            d.setDate(d.getDate() + day - 1);
            return d.toISOString().slice(0, 10);
        };
        const stops = rp.stops.map((s, i) => ({
            n: i + 1, name: s.name, day: days.dayOf[i], date: dateOf(days.dayOf[i]),
            type: s.stopType || 'pass',
            ...(s.stopType === 'overnight' ? { nights: s.nights || 1, lodging: {
                name: s.lodgingName || null, price: s.lodgingPrice || null, currency: s.lodgingCurrency, booked: !!s.lodgingBooked } } : {}),
            ...((s.spots || []).length ? { places: s.spots.map(p => p.name) } : {}),
        }));
        const legList = rp.stops.slice(0, -1).map((s, i) => {
            const l = legs[i] || {};
            // a leg leaves a stop after its nights: day of arrival + nights spent there
            const day = days.dayOf[i] + (s.stopType === 'overnight' ? (s.nights || 1) : 0);
            return { from: i + 1, to: i + 2, mode: s.legMode || 'road', day,
                     ...((s.legSpots || []).length ? { places_on_the_way: s.legSpots.map(p => p.name + (p.detour_min ? ` (+${p.detour_min} min)` : '')) } : {}),
                     km: l.distance_km != null ? Math.round(l.distance_km) : null,
                     hours: l.duration_minutes != null ? +(l.duration_minutes / 60).toFixed(1) : null,
                     ...(s.legMode !== 'road' ? { date: s.legDate || null, hours_entered_by_user: !!s.legHours,
                         ticket_cost: s.legCost || null, currency: s.legCost ? s.legCurrency : undefined, booked: !!s.legBooked } : {}) };
        });
        const drivingPerDay = {};
        legList.forEach(l => { if (l.mode === 'road' && l.hours) drivingPerDay[l.day] = +((drivingPerDay[l.day] || 0) + l.hours).toFixed(1); });

        let budget = null;
        if (window.TripBudget) {
            const c = TripBudget.collect(rp);
            const part = (items) => { const s = TripBudget.sum(items, c.base); return { total: Math.round(s.total), not_converted: s.rest }; };
            budget = { currency: c.base, fuel: part(c.fuel), fuel_settings: { l_per_100km: c.b.fuel_l_per_100km, price_per_l: c.b.fuel_price },
                       tickets: part(c.tickets), lodging: part(c.lodging), places: part(c.places),
                       other: (c.b.extras || []).filter(e => e.label).map(e => `${e.label}: ${e.amount} ${e.currency}`) };
        }
        return {
            name: document.getElementById('routeName')?.value || null,
            start_date: start, total_days: days.totalDays,
            travel_mode: document.getElementById('transportMode')?.value || 'driving',
            road_hours_per_day_without_breaks: drivingPerDay,
            stops, legs: legList, budget,
        };
    },

    render(rp) {
        const el = this.el();
        if (!el || !rp) return;
        if (rp.stops.length < 2) { el.innerHTML = ''; return; }
        const r = this.result;
        const cost = r && /^claude-sonnet-5/.test(r.model || '') && r.input_tokens != null
            ? ` · ≈ $${(r.input_tokens * 2e-6 + r.output_tokens * 10e-6).toFixed(3)}` : '';
        el.innerHTML = `
            <details class="tb ai" ${this.open ? 'open' : ''} ontoggle="AIReview.open = this.open">
                <summary>🤖 AI review of the trip</summary>
                <textarea class="on-input ai-wishes" rows="3" maxlength="2000"
                    placeholder="Who travels and what matters: e.g. «с ребёнком 8 лет, не больше 5 ч за рулём в день, любим природу и крепости, бюджет до 2000 €»"
                    oninput="AIReview.saveWishes(this.value)">${escapeHtml(this.wishes())}</textarea>
                <button class="btn btn-primary btn-sm ai-go" onclick="AIReview.run()" ${this.busy ? 'disabled' : ''}>
                    ${this.busy ? '<i class="fas fa-spinner fa-spin"></i> Claude is reading the plan… (15–60 s)' : (r ? '↻ Review again' : '🤖 Review my trip')}</button>
                ${this.error ? `<div class="ferry-msg err">${escapeHtml(this.error)}</div>` : ''}
                ${r ? `<div class="ai-out">${this.md(r.review)}</div>
                       <div class="tb-note">${escapeHtml(r.model || '')} · ${r.input_tokens ?? '?'} + ${r.output_tokens ?? '?'} tokens${cost}
                       · AI can be wrong — check ferries, borders and prices yourself</div>` : ''}
                <div class="ai-edit">
                    <div class="tb-sub">✏️ Let Claude change the route</div>
                    <textarea class="on-input ai-wishes" rows="2" maxlength="2000"
                        placeholder="What to change: e.g. «не больше 5 ч за рулём в день», «добавь ночь у моря в Греции», «убери Пизу»"
                        oninput="AIReview.editRequest = this.value">${escapeHtml(this.editRequest)}</textarea>
                    <div class="on-row">
                        <button class="btn btn-primary btn-sm" onclick="AIReview.propose(false)" ${this.editBusy ? 'disabled' : ''}>
                            ${this.editBusy ? '<i class="fas fa-spinner fa-spin"></i> Claude is planning… (20–90 s)' : '✏️ Propose changes'}</button>
                        ${r ? `<button class="btn btn-outline btn-sm" onclick="AIReview.propose(true)" ${this.editBusy ? 'disabled' : ''} title="Turn the suggestions of the review above into changes">Fix by review</button>` : ''}
                    </div>
                    ${this.editError ? `<div class="ferry-msg err">${escapeHtml(this.editError)}</div>` : ''}
                    ${this.edit ? this.proposalHtml() : ''}
                </div>
            </details>`;
    },

    async run() {
        const rp = window.routePlanner;
        if (!rp || this.busy) return;
        if (!rp.lastPlan) { window.app.showStatus('Wait until the route is calculated', 'info'); return; }
        this.busy = true; this.error = null; this.open = true;
        this.render(rp);
        try {
            // own request: a review takes 15-60 s, longer than the app's general request timeout
            const ctrl = new AbortController();
            const timer = setTimeout(() => ctrl.abort(), 150000);
            let r;
            try {
                r = await fetch(`${window.CONFIG.API_BASE_URL}/routes/ai-review`, {
                    method: 'POST', signal: ctrl.signal,
                    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${localStorage.getItem('token')}` },
                    body: JSON.stringify({ trip: await this.tripWithWeather(rp), wishes: this.wishes() || null }),
                });
            } finally { clearTimeout(timer); }
            const j = await r.json().catch(() => ({}));
            if (!r.ok) throw new Error(j.detail || `HTTP ${r.status}`);
            this.result = j;
        } catch (e) {
            this.error = `Review failed: ${e.name === 'AbortError' ? 'no answer in 2.5 min' : (e.message || e)}`;
        } finally {
            this.busy = false;
            this.render(rp);
        }
    },

    // ----- AI edits -----

    async propose(fromReview) {
        const rp = window.routePlanner;
        if (!rp || this.editBusy) return;
        if (!rp.lastPlan) { window.app.showStatus('Wait until the route is calculated', 'info'); return; }
        let request = (this.editRequest || '').trim();
        if (fromReview) {
            if (!this.result?.review) return;
            request = `Apply the suggestions of this review of the plan (section "Что изменить" first):\n\n${this.result.review}`
                + (request ? `\n\nAlso: ${request}` : '');
        }
        if (request.length < 3) { this.editError = 'Write what to change'; this.render(rp); return; }
        const wishes = this.wishes();
        if (wishes) request += `\n\nTraveller's context: ${wishes}`;
        this.editBusy = true; this.editError = null; this.edit = null; this.open = true;
        this.render(rp);
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 180000);
        try {
            const r = await fetch(`${window.CONFIG.API_BASE_URL}/routes/ai-edit`, {
                method: 'POST', signal: ctrl.signal,
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${localStorage.getItem('token')}` },
                body: JSON.stringify({ trip: await this.tripWithWeather(rp), request, coords: rp.stops.map(s => [s.lat, s.lng]) }),
            });
            const j = await r.json().catch(() => ({}));
            if (!r.ok) throw new Error(j.detail || `HTTP ${r.status}`);
            j.changes.forEach(c => { c.picked = c.ok; });
            j.planKey = this.planKey(rp);
            this.edit = j;
            if (!j.changes.length) this.editError = 'Claude proposed no changes';
        } catch (e) {
            this.editError = `Failed: ${e.name === 'AbortError' ? 'no answer in 3 min' : (e.message || e)}`;
        } finally {
            clearTimeout(timer);
            this.editBusy = false;
            this.render(rp);
        }
    },

    // the proposal refers to stop numbers: it is valid only for the plan it was made for
    planKey(rp) { return rp.stops.map(s => `${s.lat},${s.lng}`).join('|'); },

    describe(c, rp) {
        const nm = (k) => { const s = rp.stops[k - 1]; return s ? `${k}. ${escapeHtml(String(s.name).split(',')[0])}` : `#${k}`; };
        const icon = { pass: '🔁', visit: '📍', overnight: '🛏' }, modeIcon = { road: '🚗', ferry: '⛴', flight: '✈' };
        switch (c.op) {
            case 'add_stop': return `➕ Add stop <b>${escapeHtml(c.name || '?')}</b> ${c.after ? `after ${nm(c.after)}` : 'at the start'}${c.type ? ` ${icon[c.type] || ''}` : ''}${c.nights ? ` · ${c.nights} night${c.nights > 1 ? 's' : ''}` : ''}`;
            case 'remove_stop': return `✖ Remove ${nm(c.stop)}`;
            case 'move_stop': return `↕ Move ${nm(c.stop)} ${c.after ? `after ${nm(c.after)}` : 'to the start'}`;
            case 'set_stop_type': return `${icon[c.type] || ''} ${nm(c.stop)} → ${escapeHtml(c.type || '?')}`;
            case 'set_nights': return `🛏 ${nm(c.stop)}: ${c.nights} night${c.nights > 1 ? 's' : ''}`;
            case 'set_leg_mode': return `${modeIcon[c.mode] || ''} ${nm(c.stop)} → next: ${escapeHtml(c.mode || '?')}`;
            case 'add_place': return `★ At ${nm(c.stop)}: <b>${escapeHtml(c.name || '?')}</b>`;
            default: return escapeHtml(c.op);
        }
    },

    proposalHtml() {
        const rp = window.routePlanner;
        const e = this.edit;
        const stale = e.planKey !== this.planKey(rp);
        const n = e.changes.filter(c => c.picked).length;
        return `
            <div class="ai-prop">
                ${e.summary ? `<div class="ai-sum">${escapeHtml(e.summary)}</div>` : ''}
                ${e.changes.map((c, k) => `
                    <label class="ai-ch ${c.ok ? '' : 'bad'}">
                        <input type="checkbox" ${c.picked ? 'checked' : ''} ${c.ok && !stale ? '' : 'disabled'} onchange="AIReview.edit.changes[${k}].picked = this.checked; AIReview.render(routePlanner)">
                        <span><span class="ai-what">${this.describe(c, rp)}</span>
                            ${c.reason ? `<span class="ai-why">${escapeHtml(c.reason)}</span>` : ''}
                            ${c.found_name ? `<span class="ai-found" title="${escAttr(c.found_name)}">📍 ${escapeHtml(c.found_name.split(',').slice(0, 3).join(','))}</span>` : ''}
                            ${c.warning ? `<span class="ai-warn">⚠ ${escapeHtml(c.warning)}</span>` : ''}</span>
                    </label>`).join('')}
                ${stale ? '<div class="ferry-msg err">The route changed since this proposal — ask again.</div>'
                        : `<button class="btn btn-success btn-sm" onclick="AIReview.apply()" ${n ? '' : 'disabled'}>Apply ${n} change${n === 1 ? '' : 's'}</button>`}
                <div class="tb-note">${escapeHtml(e.model || '')} · ${e.input_tokens ?? '?'} + ${e.output_tokens ?? '?'} tokens · ${rp.isTripPage ? 'applied changes are saved right away' : 'nothing is saved until you press Update Route'}</div>
            </div>`;
    },

    apply() {
        const rp = window.routePlanner;
        const e = this.edit;
        if (!rp || !e || e.planKey !== this.planKey(rp)) return;
        const picked = e.changes.filter(c => c.picked && c.ok);
        const orig = rp.stops.slice();          // numbers in the proposal refer to this list
        const ref = (k) => orig[k - 1];
        const removed = new Set();
        const lastInsertedAfter = new Map();    // keep the order of several new stops after the same stop
        const newStop = (c) => ({ name: c.name, lat: c.lat, lng: c.lng, marker: null, legMode: 'road', legHours: null, legDate: null,
            ...STOP_DEFAULTS, stopType: c.type || (c.nights ? 'overnight' : 'visit'), nights: c.nights || (c.type === 'overnight' ? 1 : null) });
        const insertAfter = (anchorNo, obj) => {
            const key = anchorNo;
            const anchor = lastInsertedAfter.get(key) || (anchorNo ? ref(anchorNo) : null);
            const idx = anchor ? rp.stops.indexOf(anchor) : -1;
            rp.stops.splice(idx + 1, 0, obj);
            lastInsertedAfter.set(key, obj);
        };
        // attribute changes first, then structure
        picked.forEach(c => {
            const s = c.stop ? ref(c.stop) : null;
            if (c.op === 'set_stop_type' && s && c.type) { s.stopType = c.type; if (c.type === 'overnight' && !s.nights) s.nights = 1; }
            if (c.op === 'set_nights' && s) { s.stopType = 'overnight'; s.nights = c.nights || 1; }
            if (c.op === 'set_leg_mode' && s && c.mode) s.legMode = c.mode;
            if (c.op === 'add_place' && s && c.lat != null) {
                const spot = { name: c.name, lat: c.lat, lng: c.lng, source: 'custom', ref: null, url: null, note: c.reason || null };
                if (!(s.spots || []).some(p => spotKey(p) === spotKey(spot))) s.spots = [...(s.spots || []), spot];
                if (s.stopType === 'pass') s.stopType = 'visit';
            }
            if (c.op === 'remove_stop' && s) removed.add(s);
        });
        picked.forEach(c => {
            if (c.op === 'move_stop' && ref(c.stop) && !removed.has(ref(c.stop))) {
                const s = ref(c.stop);
                rp.stops.splice(rp.stops.indexOf(s), 1);
                insertAfter(c.after, s);
            }
            if (c.op === 'add_stop' && c.lat != null) insertAfter(c.after, newStop(c));
        });
        const remaining = rp.stops.filter(s => !removed.has(s));
        if (remaining.length < 2) { window.app.showStatus('That would leave less than 2 stops — not applied', 'error'); return; }
        if (remaining.length > 25) { window.app.showStatus('More than 25 stops — not applied', 'error'); return; }
        removed.forEach(s => { if (s.marker) window.app.map.removeLayer(s.marker); });
        rp.stops = remaining;
        // the last stop has no outgoing leg
        const last = rp.stops[rp.stops.length - 1];
        last.legMode = 'road'; last.legHours = null;
        this.edit = null;
        this.result = null;  // the review was about the old plan
        rp.refreshMarkers();
        rp.render();
        rp.calculate({ fit: true });
        window.app.showStatus(rp.isTripPage
            ? `Applied ${picked.length} change${picked.length === 1 ? '' : 's'} — saved; undo by editing the route on the map`
            : `Applied ${picked.length} change${picked.length === 1 ? '' : 's'} — check the route, then Update Route${rp.loadedRouteId ? ' (or Revert to saved)' : ''}`, 'success');
    },

    // tiny, safe markdown: everything is escaped first, then headings / lists / bold
    md(text) {
        const lines = escapeHtml(text || '').split('\n');
        let html = '', list = null;
        const close = () => { if (list) { html += `</${list}>`; list = null; } };
        const inline = s => s.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/(^|\s)\*(\S.*?)\*(?=\s|$)/g, '$1<i>$2</i>');
        lines.forEach(line => {
            let m;
            if ((m = line.match(/^#{1,4}\s+(.*)/))) { close(); html += `<div class="ai-h">${inline(m[1])}</div>`; }
            else if ((m = line.match(/^\s*[-•*]\s+(.*)/))) { if (list !== 'ul') { close(); html += '<ul>'; list = 'ul'; } html += `<li>${inline(m[1])}</li>`; }
            else if ((m = line.match(/^\s*\d+[.)]\s+(.*)/))) { if (list !== 'ol') { close(); html += '<ol>'; list = 'ol'; } html += `<li>${inline(m[1])}</li>`; }
            else if (line.trim()) { close(); html += `<p>${inline(line)}</p>`; }
        });
        close();
        return html;
    },
};

window.AIReview = AIReview;
