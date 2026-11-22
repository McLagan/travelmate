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
        const stop = { name: name || `${lat.toFixed(4)}, ${lng.toFixed(4)}`, lat, lng, marker: null, legMode: 'road', legHours: null, legDate: null };

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
            const res = await this.app.api.get('/locations/reverse', { lat: stop.lat, lon: stop.lng });
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
        const legs = this.stops.slice(0, -1).map(s => [s.legMode, s.legHours, s.legDate]).reverse();
        this.stops.reverse();
        this.stops.forEach((s, i) => {
            [s.legMode, s.legHours, s.legDate] = legs[i] || ['road', null, null];
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
            stops: this.payload().map(p => [p.name, +p.latitude.toFixed(5), +p.longitude.toFixed(5), p.leg_mode, p.leg_hours, p.leg_date]),
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
                stops: this.stops.map(s => ({ name: s.name, lat: s.lat, lng: s.lng,
                    legMode: s.legMode, legHours: s.legHours, legDate: s.legDate })),
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
        if (hashId && (explicitOpen || !(draft && draft.loadedRouteId === hashId))) {
            if (user) await this.load(hashId);
            else this.setUrlRoute(hashId);
            return;
        }
        if (!draft || !draft.stops?.length) return;

        this._restoring = true;
        draft.stops.forEach(d => this.stops.push({ name: d.name, lat: d.lat, lng: d.lng, marker: null,
            legMode: d.legMode || 'road', legHours: d.legHours ?? null, legDate: d.legDate ?? null }));
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
        }
        this.render();
    }

    payload() {
        return this.stops.map((s, i) => ({
            name: s.name, latitude: s.lat, longitude: s.lng,
            leg_mode: i < this.stops.length - 1 ? (s.legMode || 'road') : 'road',
            leg_hours: s.legHours || null,
            leg_date: s.legDate || null,
        }));
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
            <div class="ferry-box" id="ferry-${i}"></div>`;
        return `
            <div class="wp-leg-row is-${mode}">
                <button class="leg-mode" onclick="routePlanner.toggleLeg(${i})" title="${mode} — click for ${next}">${icon}</button>
                <span class="leg-info" id="leg-info-${i}"></span>
            </div>${extra}`;
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
                `<strong>${idx + 1}. ${escapeHtml(stop.name)}</strong><br>` +
                `<button class="btn btn-sm btn-danger" style="margin-top:6px" onclick="routePlanner.removeStop(${idx}); app.map.closePopup();">Remove stop</button>`
            );
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
            waypoints: this.payload()
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
            }));
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
            this.listEl.innerHTML = `
                <div class="wp-empty">
                    <i class="fas fa-mouse-pointer"></i><br>
                    Right-click the map → <b>Add to route</b>,<br>or search a place and press <b>+</b>
                </div>`;
        } else {
            const last = this.stops.length - 1;
            this.listEl.innerHTML = this.stops.map((s, i) => `${i > 0 ? this.legRowHtml(i - 1) : ''}
                <div class="wp-item">
                    <span class="wp-num ${i === 0 ? 'wp-start' : (i === last ? 'wp-end' : 'wp-mid')}">${i + 1}</span>
                    <input class="wp-name" value="${escapeHtml(s.name)}" title="${s.lat}, ${s.lng}"
                           onchange="routePlanner.renameStop(${i}, this.value)">
                    <button class="wp-btn" title="Move up" onclick="routePlanner.moveStop(${i}, -1)" ${i === 0 ? 'disabled' : ''}><i class="fas fa-arrow-up"></i></button>
                    <button class="wp-btn" title="Move down" onclick="routePlanner.moveStop(${i}, 1)" ${i === last ? 'disabled' : ''}><i class="fas fa-arrow-down"></i></button>
                    <button class="wp-btn wp-del" title="Remove" onclick="routePlanner.removeStop(${i})"><i class="fas fa-times"></i></button>
                </div>`).join('') + (this.stops.length > 1 ? `
                <div class="wp-tools">
                    <button class="wp-link" onclick="routePlanner.reverseStops()"><i class="fas fa-exchange-alt"></i> Reverse</button>
                    <button class="wp-link" onclick="routePlanner.fitToStops()"><i class="fas fa-expand"></i> Fit</button>
                    <button class="wp-link" onclick="routePlanner.clear()"><i class="fas fa-trash-alt"></i> Clear</button>
                </div>` : '');
        }
        this.renderLegInfo();
        this.renderSummary();
        this.updateButtons();
        this.saveDraft();
    }

    renderSummary(state = null) {
        if (!this.summaryEl) return;
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
        const legs = p.legs.map(l => `
            <div class="wp-leg">
                <span>${{ ferry: '⛴ ', flight: '✈ ' }[l.mode] || ''}${l.from_index + 1} → ${l.to_index + 1}</span>
                <span>${Formatter.distance(l.distance_km)}</span>
                <span>${Formatter.duration(l.duration_minutes)}</span>
            </div>`).join('');
        this.summaryEl.innerHTML = `
            <div class="wp-summary">
                <div class="wp-total">${getTransportEmoji(p.profile)} <b>${Formatter.distance(p.distance_km)}</b> · ${Formatter.duration(p.duration_minutes)}</div>
                ${p.legs.length > 1 ? legs : ''}
            </div>`;
    }
}

const DRAFT_KEY = 'travelmate_route_draft';

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
        window.routePlanner.restoreOnStart();

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
