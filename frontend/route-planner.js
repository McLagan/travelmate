/**
 * TravelMate - Multi-stop route planner
 *
 * Replaces the old start/end-only route logic:
 *  - stops are added from the map (right-click → "Add to route"), from search results,
 *    or by dragging/reordering in the sidebar list
 *  - the route is recalculated through all stops in order via POST /routes/plan
 *  - routes are saved / loaded with their full list of stops
 *
 * Loaded after app.js / features.js / map-places.js and overrides their route globals.
 */

class RoutePlanner {
    constructor(app) {
        this.app = app;
        this.stops = [];          // [{ name, lat, lng, marker }]
        this.routeLine = null;
        this.lastPlan = null;
        this.loadedRouteId = null; // set when a saved route is opened (Save then updates it)
        this.recalcTimer = null;
        this.planSeq = 0;
        this.fitNext = false;     // zoom to the whole route after the next calculation
        this.budget = { ...BUDGET_DEFAULTS, extras: [] };  // fuel, currency, extra costs of the trip
        this.carId = null;        // car of the trip (chosen on the trip page) - kept when saving from the map
        this.spotLayer = null;    // stars of the places picked at stops

        this.listEl = document.getElementById('waypointList');
        this.summaryEl = document.getElementById('routeSummary');

        const modeSelect = document.getElementById('transportMode');
        if (modeSelect) modeSelect.addEventListener('change', () => this.scheduleRecalc(0));

        this.render();
    }

    // ---------- stops ----------

    async addStop(lat, lng, name = null, index = null) {
        lat = parseFloat(Number(lat).toFixed(6));
        lng = parseFloat(Number(lng).toFixed(6));
        const stop = { name: name || `${lat.toFixed(4)}, ${lng.toFixed(4)}`, lat, lng, marker: null, legMode: 'road', legHours: null, legDate: null, ...STOP_DEFAULTS };

        if (index === null || index > this.stops.length) this.stops.push(stop);
        else this.stops.splice(index, 0, stop);

        this.refreshMarkers();
        this.render();
        this.scheduleRecalc();

        if (!name) this.resolveName(stop);
        return stop;
    }

    async resolveName(stop) {
        try {
            const res = await this.app.api.get('/locations/reverse', { lat: stop.lat, lon: stop.lng, ...placeLangParam() });
            if (res && res.name && this.stops.includes(stop)) {
                stop.name = res.name;
                this.refreshMarkers();
                this.render();
            }
        } catch (e) {
            CONFIG.debug('Reverse geocode failed', e);
        }
    }

    removeStop(i) {
        if (i > 0 && this.stops[i]?.legSpots?.length && i < this.stops.length - 1) {
            const prev = this.stops[i - 1];
            prev.legSpots = [...(prev.legSpots || []), ...this.stops[i].legSpots];
        }
        const [stop] = this.stops.splice(i, 1);
        if (stop?.marker) this.app.map.removeLayer(stop.marker);
        this.refreshMarkers();
        this.render();
        this.scheduleRecalc(0);
    }

    moveStop(i, delta) {
        const j = i + delta;
        if (j < 0 || j >= this.stops.length) return;
        [this.stops[i], this.stops[j]] = [this.stops[j], this.stops[i]];
        this.refreshMarkers();
        this.render();
        this.scheduleRecalc(0);
    }

    renameStop(i, value) {
        const v = (value || '').trim();
        if (!v || !this.stops[i]) return;
        this.stops[i].name = v;
        this.refreshMarkers();
        this.saveDraft();
    }

    reverseStops() {
        const legKeys = ['legMode', 'legHours', 'legDate', 'legCost', 'legCurrency', 'legBooked', 'legPaid', 'legRef', 'legSpots'];
        const legs = this.stops.slice(0, -1).map(s => legKeys.map(k => s[k])).reverse();
        this.stops.reverse();
        this.stops.forEach((s, i) => {
            const v = legs[i] || ['road', null, null, null, 'EUR', false, false, '', null];
            legKeys.forEach((k, j) => { s[k] = v[j]; });
        });
        this.refreshMarkers();
        this.render();
        this.scheduleRecalc(0);
    }

    // ---------- draft persistence (survives page reload) ----------

    // ---------- unsaved changes vs the saved version ----------

    snapshot() {
        return JSON.stringify({
            name: document.getElementById('routeName')?.value || '',
            description: document.getElementById('routeDescription')?.value || '',
            startDate: document.getElementById('routeStartDate')?.value || '',
            stops: this.payload().map(p => ({ ...p, latitude: +p.latitude.toFixed(5), longitude: +p.longitude.toFixed(5) })),
            budget: this.budgetPayload(),
        });
    }

    markSaved() {
        this.savedSnapshot = this.loadedRouteId ? this.snapshot() : null;
        this.updateDirty();
    }

    isDirty() {
        return !!(this.loadedRouteId && this.savedSnapshot && this.snapshot() !== this.savedSnapshot);
    }

    updateDirty() {
        let bar = document.getElementById('unsavedBar');
        if (!bar) {
            bar = document.createElement('div');
            bar.id = 'unsavedBar';
            bar.className = 'unsaved-bar';
            this.summaryEl?.after(bar);
        }
        if (this.isDirty()) {
            bar.innerHTML = `<span>● Unsaved changes</span>
                <button class="wp-link" onclick="routePlanner.revertToSaved()" title="Throw away changes and reload the saved version">↺ Revert to saved</button>`;
            bar.style.display = 'flex';
        } else {
            bar.style.display = 'none';
        }
    }

    async revertToSaved() {
        if (!this.loadedRouteId) return;
        if (!confirm('Discard your changes and go back to the saved version?')) return;
        const id = this.loadedRouteId;
        try { localStorage.removeItem(DRAFT_KEY); } catch (e) { /* ignore */ }
        await this.load(id);
        this.app.showStatus('Back to the saved version', 'success');
    }

    saveDraft() {
        this.updateDirty();
        if (!this._ready || this._restoring) return;  // don't overwrite the draft before it was restored
        try {
            if (!this.stops.length) {
                localStorage.removeItem(DRAFT_KEY);
                return;
            }
            localStorage.setItem(DRAFT_KEY, JSON.stringify({
                v: 1, savedAt: Date.now(),
                loadedRouteId: this.loadedRouteId,
                savedSnapshot: this.savedSnapshot || null,
                name: document.getElementById('routeName')?.value || '',
                description: document.getElementById('routeDescription')?.value || '',
                profile: document.getElementById('transportMode')?.value || 'driving',
                startDate: document.getElementById('routeStartDate')?.value || '',
                budget: this.budget || null,
                carId: this.carId ?? null,
                stops: this.stops.map(s => ({ name: s.name, lat: s.lat, lng: s.lng,
                    legMode: s.legMode, legHours: s.legHours, legDate: s.legDate, ...pickStopFields(s) })),
            }));
        } catch (e) { /* storage disabled - nothing to do */ }
    }

    readDraft() {
        try { return JSON.parse(localStorage.getItem(DRAFT_KEY) || 'null'); } catch (e) { return null; }
    }

    setUrlRoute(id) {
        try {
            const url = location.pathname + location.search + (id ? `#route=${id}` : '');
            history.replaceState(null, '', url);
        } catch (e) { /* ignore */ }
    }

    async restoreOnStart() {
        try {
            await this._restore();
        } finally {
            this._ready = true;
            this.saveDraft();
        }
    }

    async _restore() {
        const m = location.hash.match(/route=(\d+)/);
        const hashId = m ? parseInt(m[1], 10) : null;
        const draft = this.readDraft();
        const user = await waitForUser(this.app);

        // "Open on map" from the profile (#route=ID&open) always shows the saved version;
        // a plain reload (#route=ID) keeps unsaved edits of that route from the draft
        const explicitOpen = /[#&]open\b/.test(location.hash);
        if (/^#new\b/.test(location.hash)) {  // "New trip" from My Trips: start from scratch
            try { localStorage.removeItem(DRAFT_KEY); } catch (e) { /* ignore */ }
            this.setUrlRoute(null);
            return;
        }
        if (hashId && (explicitOpen || !(draft && draft.loadedRouteId === hashId))) {
            if (user) await this.load(hashId);
            else this.setUrlRoute(hashId);
            return;
        }
        if (!draft || !draft.stops?.length) return;

        this._restoring = true;
        draft.stops.forEach(d => this.stops.push({ name: d.name, lat: d.lat, lng: d.lng, marker: null,
            legMode: d.legMode || 'road', legHours: d.legHours ?? null, legDate: d.legDate ?? null,
            ...STOP_DEFAULTS, ...pickStopFields(d) }));
        const sd = document.getElementById('routeStartDate'); if (sd) sd.value = draft.startDate || '';
        this.budget = { ...BUDGET_DEFAULTS, ...(draft.budget || {}) };
        this.carId = draft.carId ?? null;
        this.loadedRouteId = draft.loadedRouteId || null;
        this.savedSnapshot = draft.savedSnapshot || null;
        const n = document.getElementById('routeName'); if (n) n.value = draft.name || '';
        const d = document.getElementById('routeDescription'); if (d) d.value = draft.description || '';
        const t = document.getElementById('transportMode'); if (t && draft.profile) t.value = draft.profile;
        this.refreshMarkers();
        this.render();
        this.fitToStops();
        this._restoring = false;
        if (this.loadedRouteId) this.setUrlRoute(this.loadedRouteId);
        this.updateDirty();
        if (user && this.stops.length >= 2) await this.calculate({ fit: true });
        this.app.showStatus(this.isDirty() ? 'Restored your unsaved changes — “Revert to saved” throws them away'
                                           : 'Restored your route from the last session', 'info');
    }

    clear(keepIdentity = false) {
        if (window.AIReview) { AIReview.result = null; AIReview.error = null; }
        this.stops.forEach(s => s.marker && this.app.map.removeLayer(s.marker));
        this.stops = [];
        this.clearLine();
        this.lastPlan = null;
        if (!keepIdentity) {
            this.loadedRouteId = null;
            this.savedSnapshot = null;
            this.setUrlRoute(null);
            const n = document.getElementById('routeName'); if (n) n.value = '';
            const d = document.getElementById('routeDescription'); if (d) d.value = '';
            const sd = document.getElementById('routeStartDate'); if (sd) sd.value = '';
            this.budget = { ...BUDGET_DEFAULTS, extras: [] };
            this.carId = null;
        }
        this.render();
    }

    payload() {
        return stopsPayload(this.stops);
    }

    budgetPayload() {
        return budgetPayload(this.budget, this.carId);
    }

    // ---------- legs (road / ferry) ----------

    toggleLeg(i) {
        const s = this.stops[i];
        if (!s) return;
        // cycle: road -> ferry -> flight -> road
        s.legMode = { road: 'ferry', ferry: 'flight', flight: 'road' }[s.legMode || 'road'] || 'road';
        this.render();
        this.scheduleRecalc(0);
    }

    setLegHours(i, v) {
        const h = parseFloat(String(v).replace(',', '.'));
        this.stops[i].legHours = h > 0 ? h : null;
        this.scheduleRecalc(0);
    }

    setLegDate(i, v) {
        this.stops[i].legDate = v || null;
        this.saveDraft();
    }

    legRowHtml(i) {
        const s = this.stops[i];
        const mode = s.legMode || 'road';
        const icon = { road: '🚗', ferry: '⛴', flight: '✈' }[mode];
        const next = { road: 'ferry', ferry: 'flight', flight: 'road' }[mode];
        const extra = mode === 'road' ? '' : `
            <div class="leg-ferry">
                <label title="${mode === 'flight' ? 'Flight time' : 'Crossing time from the timetable'}">⏱ <input type="text" inputmode="decimal" class="leg-hours" placeholder="hours"
                    value="${s.legHours ?? ''}" onchange="routePlanner.setLegHours(${i}, this.value)"> h</label>
                <input type="date" class="leg-date" value="${s.legDate ?? ''}" onchange="routePlanner.setLegDate(${i}, this.value)">
                ${mode === 'flight'
                    ? `<button class="wp-link leg-find leg-find-flight" onclick="findFlights(${i})">✈ Flights & tickets</button>`
                    : `<button class="wp-link leg-find" onclick="findFerries(${i})">⛴ Sailings & tickets</button>`}
            </div>
            <div class="leg-money">
                💶 <input class="on-input on-price" inputmode="decimal" placeholder="Tickets total" value="${s.legCost ?? ''}"
                    onchange="routePlanner.setStopField(${i}, 'legCost', this.value)">
                <select class="on-cur" onchange="routePlanner.setStopField(${i}, 'legCurrency', this.value)">${currencyOptions(s.legCurrency)}</select>
                ${bookedPaidHtml(i, 'leg', s.legCost, s.legBooked, s.legPaid)}
                <input class="on-input leg-ref" placeholder="Booking no. / link" value="${escAttr(s.legRef || '')}"
                    onchange="routePlanner.setStopField(${i}, 'legRef', this.value)">
            </div>
            <div class="ferry-box" id="ferry-${i}"></div>`;
        return `
            <div class="wp-leg-row is-${mode}">
                <button class="leg-mode" onclick="routePlanner.toggleLeg(${i})" title="${mode} — click for ${next}">${icon}</button>
                <span class="leg-info" id="leg-info-${i}"></span>
            </div>${extra}${this.legSpotsHtml(i)}`;
    }

    renderLegInfo() {
        const legs = this.lastPlan?.legs || [];
        legs.forEach((l, i) => {
            const el = document.getElementById(`leg-info-${i}`);
            if (!el) return;
            const est = l.mode !== 'road' && !l.hours_given ? ' (est., enter hours)' : '';
            el.textContent = `${Formatter.distance(l.distance_km)} · ${Formatter.duration(l.duration_minutes)}${est}`;
            // road leg much longer than the straight line = probably a sea crossing
            const a = this.stops[i], b = this.stops[i + 1];
            if (l.mode === 'road' && a && b) {
                const straight = L.latLng(a.lat, a.lng).distanceTo(L.latLng(b.lat, b.lng)) / 1000;
                if (l.distance_km > 200 && l.distance_km > straight * 3) {
                    const hint = document.createElement('button');
                    hint.className = 'leg-hint';
                    hint.textContent = `⚠ ${Math.round(l.distance_km / straight)}× the straight line — ferry? ⛴`;
                    hint.title = 'Mark this leg as a ferry crossing';
                    hint.onclick = () => this.toggleLeg(i);
                    el.appendChild(document.createElement('br'));
                    el.appendChild(hint);
                }
            }
        });
    }

    // ---------- stops: pass / visit / overnight, days ----------

    cycleStopType(i) {
        const s = this.stops[i];
        if (!s) return;
        s.stopType = { pass: 'visit', visit: 'overnight', overnight: 'pass' }[s.stopType || 'pass'];
        if (s.stopType === 'overnight' && !s.nights) s.nights = 1;
        this.render();
    }

    setStopField(i, field, value) {
        const s = this.stops[i];
        if (!s) return;
        if (field === 'nights') value = Math.max(1, parseInt(value, 10) || 1);
        if (field === 'lodgingPrice' || field === 'legCost') {
            const v = parseFloat(String(value).replace(',', '.'));
            value = isNaN(v) ? null : v;
        }
        s[field] = value;
        if (field === 'lodgingBooked' && !value) s.lodgingPaid = false;
        if (field === 'legBooked' && !value) s.legPaid = false;
        if (['nights', 'lodgingPrice', 'legCost', 'lodgingBooked', 'legBooked'].includes(field)) this.render(); else this.saveDraft();
        this.renderSummary();
    }

    // date we are at stop i (leaving=true: the day we leave it) - for the weather on the map cards
    stopDate(i, leaving = false) {
        return stopDate(this.stops, i, document.getElementById('routeStartDate')?.value, leaving);
    }

    // which day each stop falls on: an overnight stop with N nights moves the next stops N days later
    dayPlan() {
        return computeDayPlan(this.stops, document.getElementById('routeStartDate')?.value);
    }

    // ---------- places picked at a stop ----------

    spotsHtml(i) {
        const s = this.stops[i];
        const list = s.spots || [];
        if (s.stopType === 'pass' && !list.length) return '';
        const icon = { community: '👣', mine: '👣', custom: '✎' };
        return `
            <div class="spots">
                ${list.map((p, k) => `
                    <div class="spot-row">
                        <button class="spot-name" onclick="routePlanner.focusSpot(${i}, ${k})" title="Show on map">${icon[p.source] || '★'} ${escapeHtml(p.name)}</button>
                        ${p.url ? `<a href="${escAttr(p.url)}" target="_blank" rel="noopener" title="Open">↗</a>` : ''}
                        <button class="wp-btn spot-around" title="Popular around ${escAttr(p.name)}" onclick="StopPlaces.open(${i}, { lat: ${+p.lat}, lng: ${+p.lng}, name: routePlanner.stops[${i}].spots[${k}].name })">🔍</button>
                        <input class="spot-cost" inputmode="decimal" placeholder="€" title="Tickets / cost (for the budget)" value="${p.cost ?? ''}"
                            onchange="routePlanner.setSpotCost(${i}, ${k}, this.value)">
                        <button class="wp-btn wp-del" title="Remove" onclick="routePlanner.removeSpot(${i}, ${k})"><i class="fas fa-times"></i></button>
                    </div>`).join('')}
                <button class="wp-link spots-open" onclick="StopPlaces.open(${i})">★ Popular here${list.length ? '' : ' — pick places to see'}</button>
            </div>`;
    }

    legSpotsHtml(i) {
        const list = this.stops[i]?.legSpots || [];
        if (!list.length) return '';
        const detour = list.reduce((a, p) => a + (p.detour_min || 0), 0);
        return `
            <div class="spots leg-spots">
                ${list.map((p, k) => `
                    <div class="spot-row">
                        <button class="spot-name" onclick="routePlanner.focusLegSpot(${i}, ${k})" title="Show on map">◆ ${escapeHtml(p.name)}${p.detour_min ? ` <small>+${p.detour_min} min</small>` : ''}</button>
                        ${p.url ? `<a href="${escAttr(p.url)}" target="_blank" rel="noopener" title="Open">↗</a>` : ''}
                        <input class="spot-cost" inputmode="decimal" placeholder="€" title="Tickets / cost (for the budget)" value="${p.cost ?? ''}"
                            onchange="routePlanner.setLegSpotCost(${i}, ${k}, this.value)">
                        <button class="wp-btn wp-del" title="Remove" onclick="routePlanner.removeLegSpot(${i}, ${k})"><i class="fas fa-times"></i></button>
                    </div>`).join('')}
                ${detour ? `<div class="leg-spots-sum">on the way: ${list.length} place${list.length > 1 ? 's' : ''} · +${detour} min with visits</div>` : ''}
            </div>`;
    }

    hasLegSpot(i, key) {
        return (this.stops[i]?.legSpots || []).some(p => spotKey(p) === key);
    }

    addLegSpot(i, spot) {
        const s = this.stops[i];
        if (!s || i >= this.stops.length - 1 || this.hasLegSpot(i, spotKey(spot))) return;
        s.legSpots = [...(s.legSpots || []), spot];
        this.render();
    }

    removeLegSpot(i, k) {
        const s = this.stops[i];
        if (!s?.legSpots) return;
        s.legSpots = s.legSpots.filter((_, j) => j !== k);
        this.render();
    }

    setLegSpotCost(i, k, v) {
        const p = this.stops[i]?.legSpots?.[k];
        if (!p) return;
        const n = parseFloat(String(v).replace(',', '.'));
        p.cost = isNaN(n) ? null : n;
        if (p.cost && !p.currency) p.currency = (this.budget?.budget_currency) || 'EUR';
        this.saveDraft();
        this.renderSummary();
    }

    focusLegSpot(i, k) {
        const p = this.stops[i]?.legSpots?.[k];
        if (p) this.app.map.setView([p.lat, p.lng], Math.max(this.app.map.getZoom(), 14));
    }

    hasSpot(i, key) {
        return (this.stops[i]?.spots || []).some(p => spotKey(p) === key);
    }

    addSpot(i, spot) {
        const s = this.stops[i];
        if (!s || this.hasSpot(i, spotKey(spot))) return;
        if (s.stopType === 'pass') s.stopType = 'visit';  // picking places means we stop here
        s.spots = [...(s.spots || []), spot];
        this.render();
    }

    removeSpotByKey(i, key) {
        const s = this.stops[i];
        if (!s) return;
        s.spots = (s.spots || []).filter(p => spotKey(p) !== key);
        this.render();
    }

    removeSpot(i, k) {
        const s = this.stops[i];
        if (!s?.spots) return;
        s.spots = s.spots.filter((_, j) => j !== k);
        this.render();
    }

    setSpotCost(i, k, v) {
        const p = this.stops[i]?.spots?.[k];
        if (!p) return;
        const n = parseFloat(String(v).replace(',', '.'));
        p.cost = isNaN(n) ? null : n;
        if (p.cost && !p.currency) p.currency = (this.budget?.budget_currency) || 'EUR';
        this.saveDraft();
        this.renderSummary();
    }

    focusSpot(i, k) {
        const p = this.stops[i]?.spots?.[k];
        if (p) this.app.map.setView([p.lat, p.lng], Math.max(this.app.map.getZoom(), 15));
    }

    refreshSpotMarkers() {
        if (!this.app.map || typeof L === 'undefined') return;
        if (this.spotLayer) this.spotLayer.clearLayers();
        else this.spotLayer = L.layerGroup().addTo(this.app.map);
        this.stops.forEach((s, i) => (s.spots || []).forEach(p => {
            const _m = L.marker([p.lat, p.lng], {
                icon: L.divIcon({ className: 'spot-marker-wrap', html: `<div class="spot-marker">${p.source === 'community' || p.source === 'mine' ? '👣' : '★'}</div>`,
                                  iconSize: [22, 22], iconAnchor: [11, 11] }),
                zIndexOffset: -100,
            }).bindPopup(`<strong>${escapeHtml(p.name)}</strong> <small>· stop ${i + 1}</small><div class="wiki-card" data-wiki></div>`, { maxWidth: 300, minWidth: 220 })
              .addTo(this.spotLayer);
            WikiCard.attach(_m, () => ({ name: p.name, lat: p.lat, lng: p.lng, label: `${p.name} · stop ${i + 1}`, maxKm: 10, date: this.stopDate(i) }));
        }));
        this.stops.forEach((s, i) => (i < this.stops.length - 1 ? (s.legSpots || []) : []).forEach(p => {
            const _m = L.marker([p.lat, p.lng], {
                icon: L.divIcon({ className: 'spot-marker-wrap', html: '<div class="spot-marker on-way">◆</div>', iconSize: [20, 20], iconAnchor: [10, 10] }),
                zIndexOffset: -100,
            }).bindPopup(`<strong>${escapeHtml(p.name)}</strong> <small>· on the way ${i + 1} → ${i + 2}${p.detour_min ? ` · +${p.detour_min} min` : ''}</small><div class="wiki-card" data-wiki></div>`, { maxWidth: 300, minWidth: 220 })
              .addTo(this.spotLayer);
            WikiCard.attach(_m, () => ({ name: p.name, lat: p.lat, lng: p.lng, label: p.name, maxKm: 10, date: this.stopDate(i, true) }));
        }));
    }

    overnightHtml(i, days) {
        const s = this.stops[i];
        const n = s.nights || 1;
        const until = days.fmt(days.dayOf[i] + n);
        return `
            <div class="overnight">
                <div class="on-row">🛏 <input type="number" min="1" max="60" class="on-nights" value="${n}"
                        onchange="routePlanner.setStopField(${i}, 'nights', this.value)"> night${n > 1 ? 's' : ''}
                    <span class="on-until">→ leave ${escapeHtml(until)}</span></div>
                <input class="on-input" placeholder="Where we sleep (hotel, apartment, camping)" value="${escAttr(s.lodgingName || '')}"
                    onchange="routePlanner.setStopField(${i}, 'lodgingName', this.value)">
                <div class="on-row">
                    <input class="on-input" placeholder="Booking link" value="${escAttr(s.lodgingUrl || '')}"
                        onchange="routePlanner.setStopField(${i}, 'lodgingUrl', this.value)">
                    ${/^https?:\/\//i.test(s.lodgingUrl || '') ? `<a href="${escAttr(s.lodgingUrl)}" target="_blank" rel="noopener" title="Open booking">↗</a>`
                        : `<a class="on-find" href="${escAttr(bookingSearchUrl(String(s.name).split(',').slice(0, 2).join(','), stayDates(this.stops, i, document.getElementById('routeStartDate')?.value)))}" target="_blank" rel="noopener" title="Search Booking.com for these dates (guests and rating: set in Budget → Bookings)">Booking.com ↗</a>`}
                </div>
                <div class="on-row">
                    <input class="on-input on-price" inputmode="decimal" placeholder="Price total" value="${s.lodgingPrice ?? ''}"
                        onchange="routePlanner.setStopField(${i}, 'lodgingPrice', this.value)">
                    <select class="on-cur" onchange="routePlanner.setStopField(${i}, 'lodgingCurrency', this.value)">
                        ${currencyOptions(s.lodgingCurrency)}
                    </select>
                    ${bookedPaidHtml(i, 'lodging', s.lodgingPrice, s.lodgingBooked, s.lodgingPaid)}
                </div>
            </div>`;
    }

    clearLine() {
        if (this.routeLine) {
            this.app.map.removeLayer(this.routeLine);
            this.routeLine = null;
        }
    }

    // ---------- map markers ----------

    markerIcon(i) {
        const last = this.stops.length - 1;
        const cls = i === 0 ? 'wp-start' : (i === last ? 'wp-end' : 'wp-mid');
        return L.divIcon({
            className: 'wp-marker-wrap',
            html: `<div class="wp-marker ${cls}">${i + 1}</div>`,
            iconSize: [28, 28],
            iconAnchor: [14, 14],
            popupAnchor: [0, -14]
        });
    }

    refreshMarkers() {
        this.stops.forEach((stop, i) => {
            if (!stop.marker) {
                stop.marker = L.marker([stop.lat, stop.lng], { draggable: true, icon: this.markerIcon(i) })
                    .addTo(this.app.map);
                stop.marker.on('dragend', (e) => {
                    const p = e.target.getLatLng();
                    stop.lat = parseFloat(p.lat.toFixed(6));
                    stop.lng = parseFloat(p.lng.toFixed(6));
                    stop.name = `${stop.lat.toFixed(4)}, ${stop.lng.toFixed(4)}`;
                    this.render();
                    this.scheduleRecalc(0);
                    this.resolveName(stop);
                });
            } else {
                stop.marker.setIcon(this.markerIcon(i));
                stop.marker.setLatLng([stop.lat, stop.lng]);
            }
            const idx = i;
            stop.marker.bindPopup(
                `<strong>${idx + 1}. ${escapeHtml(stop.name)}</strong>` +
                `<div class="wiki-card" data-wiki></div>` +
                `<button class="btn btn-sm btn-danger" style="margin-top:6px" onclick="routePlanner.removeStop(${idx}); app.map.closePopup();">Remove stop</button>`,
                { maxWidth: 300, minWidth: 220 }
            );
            WikiCard.attach(stop.marker, () => ({ name: stop.name, lat: stop.lat, lng: stop.lng, label: `${idx + 1}. ${stop.name}`, maxKm: 30, date: this.stopDate(idx) }));
        });
    }

    // ---------- routing ----------

    scheduleRecalc(delay = 400) {
        clearTimeout(this.recalcTimer);
        this.saveDraft();
        this.syncLegacyPoints(false);
        if (this.stops.length < 2) {
            this.clearLine();
            this.lastPlan = null;
            this.renderSummary();
            this.updateButtons();
            return;
        }
        this.recalcTimer = setTimeout(() => this.calculate(), delay);
    }

    async calculate({ fit = false } = {}) {
        fit = fit || this.fitNext;
        this.fitNext = false;
        if (this.stops.length < 2) {
            this.app.showStatus('Add at least 2 stops', 'error');
            return null;
        }
        const profile = document.getElementById('transportMode')?.value || 'driving';
        const seq = ++this.planSeq;
        this.renderSummary('loading');

        try {
            const plan = await this.app.api.post('/routes/plan', {
                profile,
                waypoints: this.payload()
            });
            if (seq !== this.planSeq) return null; // a newer request superseded this one

            this.lastPlan = plan;
            this.clearLine();
            const segs = (plan.segments && plan.segments.length) ? plan.segments : [{ mode: 'road', coordinates: plan.geometry.coordinates }];
            this.routeLine = L.featureGroup(segs.map(seg => L.polyline(seg.coordinates.map(c => [c[1], c[0]]),
                seg.mode === 'ferry'
                    ? { color: '#0284c7', weight: 4, opacity: 0.9, dashArray: '8 10' }
                    : seg.mode === 'flight'
                    ? { color: '#7c3aed', weight: 3, opacity: 0.9, dashArray: '2 8' }
                    : { color: getTransportColor(profile), weight: 5, opacity: 0.85, lineJoin: 'round' }
            ))).addTo(this.app.map);
            this.stops.forEach(s => s.marker && s.marker.bringToFront && s.marker.bringToFront());

            if (fit) this.app.map.fitBounds(this.routeLine.getBounds(), { padding: [30, 30] });
            this.syncLegacyPoints(true);
            this.renderLegInfo();
            this.renderSummary();
            this.updateButtons();
            return plan;
        } catch (error) {
            if (seq !== this.planSeq) return null;
            this.lastPlan = null;
            this.clearLine();
            this.renderSummary('error');
            this.app.errorHandler.handle(error, 'Route calculation failed');
            return null;
        }
    }

    // POI explorer (features.js) still reads app.startPoint / app.endPoint
    syncLegacyPoints(routeReady) {
        const first = this.stops[0], last = this.stops[this.stops.length - 1];
        this.app.startPoint = first ? { lat: first.lat, lng: first.lng, name: first.name } : null;
        this.app.endPoint = (last && this.stops.length > 1) ? { lat: last.lat, lng: last.lng, name: last.name } : null;
        const poiBtn = document.getElementById('explorePOIsBtn');
        if (poiBtn) poiBtn.disabled = !(routeReady && this.stops.length >= 2);
    }

    fitToStops() {
        if (this.routeLine) {
            this.app.map.fitBounds(this.routeLine.getBounds(), { padding: [30, 30] });
        } else if (this.stops.length) {
            this.app.map.fitBounds(L.latLngBounds(this.stops.map(s => [s.lat, s.lng])).pad(0.2));
        }
    }

    // ---------- save / load ----------

    async save() {
        if (this.stops.length < 2) {
            this.app.showStatus('Add at least 2 stops', 'error');
            return;
        }
        const name = document.getElementById('routeName')?.value?.trim();
        const description = document.getElementById('routeDescription')?.value?.trim() || null;
        if (!name) {
            this.app.showStatus('Please enter a route name', 'error');
            document.getElementById('routeName')?.focus();
            return;
        }
        const payload = {
            name, description,
            start_date: document.getElementById('routeStartDate')?.value || null,
            waypoints: this.payload(),
            ...this.budgetPayload(),
        };
        try {
            let saved;
            if (this.loadedRouteId) {
                saved = await this.app.api.put(`/routes/${this.loadedRouteId}`, payload);
            } else {
                saved = await this.app.api.post('/routes/', payload);
            }
            this.loadedRouteId = saved.id;
            this.setUrlRoute(saved.id);
            this.markSaved();
            this.saveDraft();
            this.app.api.cache.clear();
            this.render();
            this.app.showStatus(`Route "${saved.name}" saved (${saved.waypoints.length} stops)`, 'success');
            if (document.getElementById('routesList')?.style.display === 'block') loadRoutes();
        } catch (error) {
            this.app.errorHandler.handle(error, 'Failed to save route');
        }
    }

    saveAsNew() {
        this.loadedRouteId = null;
        return this.save();
    }

    async load(routeId) {
        try {
            const route = await this.app.api.get(`/routes/${routeId}`, { _: Date.now() });
            this.clear();
            route.waypoints.forEach(w => this.stops.push({
                name: w.name, lat: w.latitude, lng: w.longitude, marker: null,
                legMode: w.leg_mode || 'road', legHours: w.leg_hours ?? null, legDate: w.leg_date ?? null,
                ...stopFromApi(w),
            }));
            this.budget = { ...BUDGET_DEFAULTS };
            Object.keys(BUDGET_DEFAULTS).forEach(k => { if (route[k] !== null && route[k] !== undefined) this.budget[k] = route[k]; });
            this.budget.extras = Array.isArray(route.extras) ? route.extras : [];
            this.carId = route.car_id ?? null;
            const sd = document.getElementById('routeStartDate'); if (sd) sd.value = route.start_date || '';
            this.loadedRouteId = route.id;
            this.setUrlRoute(route.id);
            document.getElementById('routeName').value = route.name || '';
            document.getElementById('routeDescription').value = route.description || '';
            this.markSaved();
            this.refreshMarkers();
            this.render();
            this.fitToStops();
            await this.calculate({ fit: true });
            this.app.showStatus(`Loaded route: ${route.name}`, 'success');
            // the stop list sits low in the side panel — bring it into view
            setTimeout(() => document.getElementById('stopsLabel')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 300);
        } catch (error) {
            this.app.errorHandler.handle(error, 'Failed to load route');
        }
    }

    // ---------- rendering ----------

    updateButtons() {
        const enough = this.stops.length >= 2 && !!this.app.currentUser;
        ['realRouteBtn', 'createRouteBtn'].forEach(id => {
            const el = document.getElementById(id);
            if (el) el.disabled = !enough;
        });
        const saveBtn = document.getElementById('createRouteBtn');
        if (saveBtn) {
            saveBtn.innerHTML = this.loadedRouteId
                ? '<i class="fas fa-save"></i> Update Route'
                : '<i class="fas fa-save"></i> Save Route';
        }
        const asNew = document.getElementById('saveAsNewBtn');
        if (asNew) asNew.style.display = this.loadedRouteId ? 'block' : 'none';
    }

    render() {
        if (!this.listEl) return;
        if (!this.stops.length) {
            document.getElementById('stopsHint')?.style.setProperty('display', 'none');
            this.listEl.innerHTML = `
                <div class="wp-empty">
                    <i class="fas fa-mouse-pointer"></i><br>
                    Right-click the map → <b>Add to route</b>,<br>or search a place and press <b>+</b>
                </div>`;
        } else {
            const hint = document.getElementById('stopsHint');
            if (hint) hint.style.display = this.stops.some(x => x.stopType === 'overnight') ? 'none' : 'block';
            const last = this.stops.length - 1;
            const days = this.dayPlan();
            this.listEl.innerHTML = this.stops.map((s, i) => `${i > 0 ? this.legRowHtml(i - 1) : ''}
                ${days.headerAt[i] ? `<div class="day-head">${days.headerAt[i]}</div>` : ''}
                <div class="wp-item">
                    <button class="stop-type" onclick="routePlanner.cycleStopType(${i})" title="${STOP_TYPES[s.stopType || 'pass'].title} — click to change">${STOP_TYPES[s.stopType || 'pass'].icon}</button>
                    <span class="wp-num ${i === 0 ? 'wp-start' : (i === last ? 'wp-end' : 'wp-mid')}">${i + 1}</span>
                    <input class="wp-name" value="${escapeHtml(s.name)}" title="${s.lat}, ${s.lng}"
                           onchange="routePlanner.renameStop(${i}, this.value)">
                    <button class="wp-btn" title="Move up" onclick="routePlanner.moveStop(${i}, -1)" ${i === 0 ? 'disabled' : ''}><i class="fas fa-arrow-up"></i></button>
                    <button class="wp-btn" title="Move down" onclick="routePlanner.moveStop(${i}, 1)" ${i === last ? 'disabled' : ''}><i class="fas fa-arrow-down"></i></button>
                    <button class="wp-btn wp-del" title="Remove" onclick="routePlanner.removeStop(${i})"><i class="fas fa-times"></i></button>
                </div>${s.stopType === 'overnight' ? this.overnightHtml(i, days) : ''}${this.spotsHtml(i)}`).join('') + (this.stops.length > 1 ? `
                <div class="wp-tools">
                    <button class="wp-link" onclick="routePlanner.reverseStops()"><i class="fas fa-exchange-alt"></i> Reverse</button>
                    <button class="wp-link" onclick="routePlanner.fitToStops()"><i class="fas fa-expand"></i> Fit</button>
                    <button class="wp-link" onclick="routePlanner.clear()"><i class="fas fa-trash-alt"></i> Clear</button>
                </div>` : '');
        }
        this.renderLegInfo();
        this.renderSummary();
        this.refreshSpotMarkers();
        this.updateButtons();
        this.saveDraft();
    }

    renderSummary(state = null) {
        if (!this.summaryEl) return;
        window.TripBudget?.render(this);
        window.AIReview?.render(this);
        if (state === 'loading') {
            this.summaryEl.innerHTML = '<div class="wp-summary muted"><i class="fas fa-spinner fa-spin"></i> Calculating…</div>';
            return;
        }
        if (state === 'error') {
            this.summaryEl.innerHTML = '<div class="wp-summary error">Could not calculate the route for these points</div>';
            return;
        }
        const p = this.lastPlan;
        if (!p || this.stops.length < 2) {
            this.summaryEl.innerHTML = '';
            return;
        }
        const nights = this.stops.reduce((a, s) => a + (s.stopType === 'overnight' ? (s.nights || 1) : 0), 0);
        const lodging = {};
        this.stops.forEach(s => {
            if (s.stopType === 'overnight' && s.lodgingPrice) {
                const c = s.lodgingCurrency || 'EUR';
                lodging[c] = (lodging[c] || 0) + s.lodgingPrice;
            }
        });
        const lodgingTxt = Object.entries(lodging).map(([c, v]) => `${Math.round(v)} ${c}`).join(' + ');
        const tripLine = nights ? `<div class="wp-trip">${nights + 1} days · ${nights} night${nights > 1 ? 's' : ''}${lodgingTxt ? ` · 🛏 ${lodgingTxt}` : ''}</div>` : '';
        const legs = p.legs.map(l => `
            <div class="wp-leg">
                <span>${{ ferry: '⛴ ', flight: '✈ ' }[l.mode] || ''}${l.from_index + 1} → ${l.to_index + 1}</span>
                <span>${Formatter.distance(l.distance_km)}</span>
                <span>${Formatter.duration(l.duration_minutes)}</span>
            </div>`).join('');
        this.summaryEl.innerHTML = `
            <div class="wp-summary">
                ${tripLine}
                <div class="wp-total">${getTransportEmoji(p.profile)} <b>${Formatter.distance(p.distance_km)}</b> · ${Formatter.duration(p.duration_minutes)}</div>
                ${p.legs.length > 1 ? legs : ''}
            </div>`;
    }
}

const DRAFT_KEY = 'travelmate_route_draft';

/* ---------- Wikipedia card on map markers: photo on hover, photo + description + link in the popup ---------- */
const WikiCard = {
    cache: new Map(),   // key -> Promise<info|null>

    get({ name, lat, lng, maxKm }) {
        const key = `${String(name).split(',')[0].trim().toLowerCase()}|${(+lat).toFixed(2)}|${(+lng).toFixed(2)}`;
        if (!this.cache.has(key)) {
            this.cache.set(key, window.app.api.get('/locations/wiki-near', { name, lat, lon: lng, max_km: maxKm || 30 })
                .then(r => (r && r.title ? r : null)).catch(() => null));
        }
        return this.cache.get(key);
    },

    wxLine(w, date) {
        if (!w) return '';
        const d = new Date(date + 'T12:00:00').toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
        return `<div class="wtip-wx">${escapeHtml(d)}: ${Weather.html(w)} <small class="wx-src">· Open-Meteo</small></div>`;
    },

    tipHtml(info, label, w, date) {
        const wx = this.wxLine(w, date);
        if (!info) return `<b>${escapeHtml(label)}</b>${wx}`;
        return `<div class="wtip">${info.thumbnail ? `<img src="${escAttr(info.thumbnail)}" alt="" referrerpolicy="no-referrer">` : ''}
                <b>${escapeHtml(label)}</b>${info.description ? `<small>${escapeHtml(info.description)}</small>` : ''}${wx}</div>`;
    },

    cardHtml(info) {
        if (!info) return '<div class="wiki-none">No Wikipedia article found nearby</div>';
        const url = /^https?:\/\//i.test(info.url || '') ? info.url : null;
        return `${info.thumbnail ? `<img class="wiki-img" src="${escAttr(info.thumbnail)}" alt="" referrerpolicy="no-referrer">` : ''}
            ${info.extract ? `<div class="wiki-text">${escapeHtml(info.extract.slice(0, 260))}${info.extract.length > 260 ? '…' : ''}</div>` : ''}
            ${url ? `<a href="${escAttr(url)}" target="_blank" rel="noopener">Wikipedia: ${escapeHtml(info.title)} ↗</a>` : ''}`;
    },

    attach(marker, describe) {
        marker._wikiDescribe = describe;   // stop markers are re-used: refresh what they describe, listen once
        if (marker._wikiAttached) return marker;
        marker._wikiAttached = true;
        describe = () => marker._wikiDescribe();
        marker.bindTooltip('', { direction: 'top', offset: [0, -12], className: 'wiki-tooltip', opacity: 1 });
        marker.on('mouseover', async () => {
            const d = describe();
            marker.setTooltipContent(`<b>${escapeHtml(d.label)}</b>`);
            const wx = d.date ? Weather.get(d.lat, d.lng, d.date) : Promise.resolve(null);
            const info = await this.get(d);
            if (marker.isTooltipOpen()) marker.setTooltipContent(this.tipHtml(info, d.label));
            const w = await wx;
            if (w && marker.isTooltipOpen()) marker.setTooltipContent(this.tipHtml(info, d.label, w, d.date));
        });
        marker.on('popupopen', async (e) => {
            marker.closeTooltip();
            const box = e.popup.getElement()?.querySelector('[data-wiki]');
            if (!box) return;
            box.innerHTML = '<div class="wiki-none">Loading Wikipedia…</div>';
            const d = describe();
            const [info, w] = await Promise.all([this.get(d), d.date ? Weather.get(d.lat, d.lng, d.date) : null]);
            // setContent (not update(): it redraws the original string and wipes the card) - also re-lays out the popup
            const html = String(e.popup.getContent() || '');
            const slot = '<div class="wiki-card" data-wiki></div>';
            if (marker.isPopupOpen() && html.includes(slot)) {
                e.popup.setContent(html.replace(slot, `<div class="wiki-card" data-wiki-done>${w ? `<div class="wiki-wx">${this.wxLine(w, d.date)}${Weather.ATTR}</div>` : ''}${this.cardHtml(info)}</div>`));
            }
        });
        return marker;
    },
};
window.WikiCard = WikiCard;

function waitForUser(app, timeoutMs = 8000) {
    return new Promise(resolve => {
        const t0 = Date.now();
        const tick = () => {
            if (app.currentUser) return resolve(app.currentUser);
            if (Date.now() - t0 > timeoutMs || !localStorage.getItem('token')) return resolve(null);
            setTimeout(tick, 100);
        };
        tick();
    });
}

/* ---------- ferry sailings (Ferryhopper) ---------- */

function _fmtTime(v) {
    if (!v) return '?';
    const m = String(v).match(/(\d{2}:\d{2})/);
    return m ? m[1] : String(v);
}

function _fmtPrice(p) {
    let amt = p.amount, cur = p.currency;
    // Ferryhopper appears to return integer cents without a currency (9000 = 90.00 EUR)
    if (typeof amt === 'number' && Number.isInteger(amt) && !cur && amt >= 1000) {
        amt = (amt / 100).toFixed(2);
        cur = '€ (?)';
    }
    return `${escapeHtml(String(amt))}${cur ? ' ' + escapeHtml(cur) : ''}`;
}

function _hoursBetween(a, b) {
    const da = Date.parse(a), db = Date.parse(b);
    if (isNaN(da) || isNaN(db) || db <= da) return null;
    return Math.round((db - da) / 360000) / 10;
}

async function findFerries(i) {
    const rp = window.routePlanner, app = window.app;
    const a = rp.stops[i], b = rp.stops[i + 1];
    const box = document.getElementById(`ferry-${i}`);
    if (!a || !b || !box) return;
    const today = new Date().toISOString().slice(0, 10);
    if (a.legDate && a.legDate < today) {
        box.innerHTML = `<div class="ferry-msg err">The date ${a.legDate} is in the past — pick a future date.</div>`;
        return;
    }
    if (!a.legDate) {
        const d = new Date(Date.now() + 14 * 864e5).toISOString().slice(0, 10);
        a.legDate = d;
        const inp = box.previousElementSibling?.querySelector('.leg-date');
        if (inp) inp.value = d;
    }
    box.innerHTML = '<div class="ferry-msg">Searching sailings…</div>';
    try {
        const res = await app.api.post('/ferries/search', { from_name: a.name, to_name: b.name, date: a.legDate });
        window._ferryResults = window._ferryResults || {};
        window._ferryResults[i] = res;
        const links = `<div class="ferry-links">Book on: ${res.links.map(l => `<a href="${l.url}" target="_blank" rel="noopener">${escapeHtml(l.label)}</a>`).join(' · ')}</div>`;
        if (res.error) {
            box.innerHTML = `<div class="ferry-msg err" title="${escapeHtml(res.error)}">Ferryhopper search failed (${escapeHtml(res.error.slice(0, 80))})</div>${links}`;
            return;
        }
        if (!res.options.length) {
            const tried = (res.tried || []).map(escapeHtml).join('; ');
            const raw = res.raw ? `<details class="ferry-raw"><summary>Ferryhopper answer (for debugging)</summary><pre>${escapeHtml(typeof res.raw === 'string' ? res.raw : JSON.stringify(res.raw, null, 1).slice(0, 4000))}</pre></details>` : '';
            const ports = res.ports ? `Ferryhopper knows the ports ${escapeHtml(res.ports)}, but` : `Ferryhopper`;
            const until = res.searched_until ? ` from ${res.date} to ${res.searched_until}` : ` on ${res.date}`;
            box.innerHTML = `<div class="ferry-msg">${ports} has no sailings${until}${!res.ports && tried ? ` (tried: ${tried})` : ''}. The line may not run then or not be sold there — check the other sites:</div>${raw}${links}`;
            return;
        }
        const shifted = res.found_date && res.found_date !== res.date
            ? `<div class="ferry-msg">No sailings on ${res.date} — nearest: <b>${res.found_date}</b></div>` : '';
        box.innerHTML = shifted + res.options.map((o, k) => {
            const price = o.price ? ` · from ${_fmtPrice(o.price)}` : '';
            const hrs = _hoursBetween(o.departure, o.arrival);
            return `<div class="ferry-opt">
                <div><b>${_fmtTime(o.departure)} → ${_fmtTime(o.arrival)}</b>${hrs ? ` (${hrs} h)` : ''}${price}<br>
                    <small>${escapeHtml(o.operator || '')}${o.vessel ? ' · ' + escapeHtml(o.vessel) : ''}</small></div>
                <div class="ferry-actions">
                    ${hrs ? `<button class="ferry-use" onclick="useFerry(${i}, ${k})" title="Put this crossing time (and date) into the route">Use ${hrs} h</button>` : ''}
                    ${o.url ? `<a class="poi-add" href="${o.url}" target="_blank" rel="noopener">Book</a>`
                            : (o.id ? `<button class="poi-add" onclick="ferryBook(${i}, ${k})">Book</button>` : '')}
                </div>
            </div>`;
        }).join('') + links + '<div class="ferry-src">Prices are indicative (Ferryhopper)</div>';
        // nothing entered yet: take the first sailing's time automatically
        const firstWithTime = res.options.findIndex(o => _hoursBetween(o.departure, o.arrival));
        if (!a.legHours && firstWithTime >= 0) useFerry(i, firstWithTime);
    } catch (error) {
        box.innerHTML = `<div class="ferry-msg err">Search failed</div>`;
        app.errorHandler.handle(error, 'Ferry search failed');
    }
}

async function ferryBook(i, k) {
    const o = window._ferryResults?.[i]?.options?.[k];
    if (!o) return;
    const win = window.open('about:blank', '_blank');  // open now, while the click still counts as user action
    try {
        const r = await window.app.api.get('/ferries/link', { trip_id: o.id });
        o.url = r.url;
        if (win) win.location = r.url; else window.open(r.url, '_blank');
    } catch (e) {
        const fallback = window._ferryResults[i].links?.[0]?.url || 'https://www.ferryhopper.com/';
        if (win) win.location = fallback; else window.open(fallback, '_blank');
        window.app.showStatus('No direct booking link — opened Ferryhopper, pick the sailing there', 'info');
    }
}

function useFerry(i, k, kind = 'ferry') {
    const store = kind === 'flight' ? window._flightResults : window._ferryResults;
    const o = store?.[i]?.options?.[k];
    const h = o && (o.hours || _hoursBetween(o.departure, o.arrival));
    if (!h) return;
    window.routePlanner.stops[i].legHours = h;
    if (o.date) {
        window.routePlanner.stops[i].legDate = o.date;
        const d = document.querySelector(`#ferry-${i}`)?.previousElementSibling?.querySelector('.leg-date');
        if (d) d.value = o.date;
    }
    const inp = document.querySelector(`#ferry-${i}`)?.previousElementSibling?.querySelector('.leg-hours');
    if (inp) inp.value = h;
    window.routePlanner.scheduleRecalc(0);
    window.app.showStatus(`${kind === 'flight' ? 'Flight' : 'Ferry crossing'} time set to ${h} h`, 'success');
}

async function findFlights(i) {
    const rp = window.routePlanner, app = window.app;
    const a = rp.stops[i], b = rp.stops[i + 1];
    const box = document.getElementById(`ferry-${i}`);
    if (!a || !b || !box) return;
    const today = new Date().toISOString().slice(0, 10);
    if (a.legDate && a.legDate < today) {
        box.innerHTML = `<div class="ferry-msg err">The date ${a.legDate} is in the past — pick a future date.</div>`;
        return;
    }
    if (!a.legDate) {
        a.legDate = new Date(Date.now() + 14 * 864e5).toISOString().slice(0, 10);
        const inp = box.previousElementSibling?.querySelector('.leg-date');
        if (inp) inp.value = a.legDate;
        rp.saveDraft();
    }
    box.innerHTML = '<div class="ferry-msg">Searching flights…</div>';
    try {
        const res = await app.api.post('/flights/search', {
            from_name: a.name, to_name: b.name, date: a.legDate,
            from_lat: a.lat, from_lon: a.lng, to_lat: b.lat, to_lon: b.lng,
        });
        window._flightResults = window._flightResults || {};
        window._flightResults[i] = res;
        const links = `<div class="ferry-links">Compare on: ${res.links.map(l => `<a href="${l.url}" target="_blank" rel="noopener">${escapeHtml(l.label)}</a>`).join(' · ')}</div>`;
        const head = `<div class="ferry-src">Searched ${escapeHtml(res.from)} → ${escapeHtml(res.to)}, ${res.date}</div>`;
        if (!res.options.length) {
            const why = res.error ? ` (${escapeHtml(String(res.error).slice(0, 120))})` : '';
            box.innerHTML = `${head}<div class="ferry-msg ${res.error ? 'err' : ''}">No flights found${why}. If the stop is not a city with an airport, put the stop at the airport city (e.g. “Belgrade”).</div>${links}`;
            return;
        }
        box.innerHTML = head + res.options.map((o, k) => {
            const stops = o.stops === 0 ? 'direct' : (o.stops != null ? `${o.stops} stop${o.stops > 1 ? 's' : ''}` : '');
            return `<div class="ferry-opt flight-opt">
                <div><b>${_fmtTime(o.departure)} → ${_fmtTime(o.arrival)}</b>${o.hours ? ` (${o.hours} h)` : ''}${o.price ? ` · ${escapeHtml(o.price)}` : ''}<br>
                    <small>${escapeHtml(o.route || '')}${stops ? ' · ' + stops : ''}${o.carriers?.length ? ' · ' + escapeHtml(o.carriers.join(', ')) : ''}</small></div>
                <div class="ferry-actions">
                    ${o.hours ? `<button class="ferry-use" onclick="useFerry(${i}, ${k}, 'flight')" title="Put this flight time into the route">Use ${o.hours} h</button>` : ''}
                    ${o.url ? `<a class="poi-add" href="${o.url}" target="_blank" rel="noopener">Book</a>` : ''}
                </div>
            </div>`;
        }).join('') + links + '<div class="ferry-src">Prices from Kiwi.com, may change at booking</div>';
        const first = res.options.findIndex(o => o.hours);
        if (!a.legHours && first >= 0) useFerry(i, first, 'flight');
    } catch (error) {
        box.innerHTML = '<div class="ferry-msg err">Flight search failed</div>';
        app.errorHandler.handle(error, 'Flight search failed');
    }
}

window.findFlights = findFlights;
window.ferryBook = ferryBook;

window.findFerries = findFerries;
window.useFerry = useFerry;

/* ---------- search results with "add to route" ---------- */

async function plannerSearchPlace() {
    if (!window.app?.currentUser) {
        window.app?.showAuthModal('login');
        return;
    }
    const query = document.getElementById('searchInput')?.value?.trim();
    const box = document.getElementById('searchResults');
    if (!query || query.length < 2) {
        window.app.showStatus('Search query must be at least 2 characters long', 'error');
        return;
    }
    try {
        window.app.showStatus('Searching...', 'info');
        const res = await window.app.api.get('/locations/search', { query, limit: 6 });
        const results = res.results || [];
        window._searchResults = results;
        if (!results.length) {
            box.innerHTML = '<div class="sr-empty">No places found</div>';
            window.app.showStatus('No places found', 'error');
            return;
        }
        box.innerHTML = results.map((r, i) => `
            <div class="sr-item">
                <div class="sr-text" onclick="plannerShowResult(${i})" title="Show on map">
                    <b>${escapeHtml(r.name)}</b><br><small>${escapeHtml(r.display_name)}</small>
                </div>
                <button class="wp-btn sr-add" title="Add to route" onclick="plannerAddResult(${i})"><i class="fas fa-plus"></i></button>
            </div>`).join('');
        window.app.showStatus(`Found ${results.length} places`, 'success');
    } catch (error) {
        window.app.errorHandler.handle(error, 'Search failed');
    }
}

function plannerShowResult(i) {
    const r = window._searchResults?.[i];
    if (r) window.app.map.setView([r.latitude, r.longitude], 11);
}

function plannerAddResult(i) {
    const r = window._searchResults?.[i];
    if (!r) return;
    window.routePlanner.fitNext = true;
    window.routePlanner.addStop(r.latitude, r.longitude, r.name);
    window.app.showStatus(`Added: ${r.name}`, 'success');
    document.getElementById('searchResults').innerHTML = '';
    document.getElementById('searchInput').value = '';
}

/* ---------- context menu ---------- */

function addToRouteHere(asStart = false) {
    const pm = window.app?.placesManager;
    if (!pm?.clickedCoordinates) return;
    if (!window.app.currentUser) {
        window.app.showAuthModal('login');
        return;
    }
    const { lat, lng } = pm.clickedCoordinates;
    window.routePlanner.addStop(lat, lng, null, asStart ? 0 : null);
    pm.hideContextMenu();
}

/* ---------- wire up: override old start/end globals ---------- */

document.addEventListener('DOMContentLoaded', () => {
    const wait = setInterval(() => {
        if (!window.app?.map) return;
        clearInterval(wait);

        const app = window.app;
        window.routePlanner = new RoutePlanner(app);
        ['routeName', 'routeDescription'].forEach(id =>
            document.getElementById(id)?.addEventListener('input', () => window.routePlanner.saveDraft()));
        document.getElementById('routeStartDate')?.addEventListener('change', () => window.routePlanner.render());
        window.routePlanner.restoreOnStart();
        // Same-page jump to #new (e.g. typed in the address bar) → start a fresh trip
        window.addEventListener('hashchange', () => { if (/^#new\b/.test(location.hash)) location.reload(); });
        window.addEventListener('bookingprefs', () => window.routePlanner.render());

        // Old two-point API → planner
        app.setStartPoint = (lat, lng) => window.routePlanner.addStop(lat, lng, null, 0);
        app.setEndPoint = (lat, lng) => window.routePlanner.addStop(lat, lng);
        app.calculateRoute = () => window.routePlanner.calculate({ fit: true });
        app.checkRouteReady = () => window.routePlanner.updateButtons();
        const origClearRouteDisplay = app.clearRouteDisplay.bind(app);
        app.clearRouteDisplay = () => { origClearRouteDisplay(); window.routePlanner.clear(); };

        // Re-evaluate buttons after login/logout toggles controls
        const origEnable = app.enableControls.bind(app);
        app.enableControls = () => { origEnable(); window.routePlanner.updateButtons(); };
        window.routePlanner.updateButtons();

        window.calculateRealRoute = () => window.routePlanner.calculate({ fit: true });
        window.createRoute = () => window.routePlanner.save();
        window.loadRouteOnMap = (id) => window.routePlanner.load(id);
        window.searchPlace = plannerSearchPlace;
        window.setAsStartPoint = () => addToRouteHere(true);
        window.setAsEndPoint = () => addToRouteHere(false);

        // Route list should always be fresh
        const origLoadRoutes = window.loadRoutes;
        window.loadRoutes = (...args) => { app.api.cache.clear(); return origLoadRoutes(...args); };
    }, 50);
});

window.addToRouteHere = addToRouteHere;
window.plannerAddResult = plannerAddResult;
window.plannerShowResult = plannerShowResult;
