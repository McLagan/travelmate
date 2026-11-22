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
        const stop = { name: name || `${lat.toFixed(4)}, ${lng.toFixed(4)}`, lat, lng, marker: null };

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
    }

    reverseStops() {
        this.stops.reverse();
        this.refreshMarkers();
        this.render();
        this.scheduleRecalc(0);
    }

    clear(keepIdentity = false) {
        this.stops.forEach(s => s.marker && this.app.map.removeLayer(s.marker));
        this.stops = [];
        this.clearLine();
        this.lastPlan = null;
        if (!keepIdentity) {
            this.loadedRouteId = null;
            const n = document.getElementById('routeName'); if (n) n.value = '';
            const d = document.getElementById('routeDescription'); if (d) d.value = '';
        }
        this.render();
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
                waypoints: this.stops.map(s => ({ name: s.name, latitude: s.lat, longitude: s.lng }))
            });
            if (seq !== this.planSeq) return null; // a newer request superseded this one

            this.lastPlan = plan;
            this.clearLine();
            const coords = plan.geometry.coordinates.map(c => [c[1], c[0]]);
            this.routeLine = L.polyline(coords, {
                color: getTransportColor(profile), weight: 5, opacity: 0.85, lineJoin: 'round'
            }).addTo(this.app.map);
            this.stops.forEach(s => s.marker && s.marker.bringToFront && s.marker.bringToFront());

            if (fit) this.app.map.fitBounds(this.routeLine.getBounds(), { padding: [30, 30] });
            this.syncLegacyPoints(true);
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
            waypoints: this.stops.map(s => ({ name: s.name, latitude: s.lat, longitude: s.lng }))
        };
        try {
            let saved;
            if (this.loadedRouteId) {
                saved = await this.app.api.put(`/routes/${this.loadedRouteId}`, payload);
            } else {
                saved = await this.app.api.post('/routes/', payload);
            }
            this.loadedRouteId = saved.id;
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
            route.waypoints.forEach(w => this.stops.push({ name: w.name, lat: w.latitude, lng: w.longitude, marker: null }));
            this.loadedRouteId = route.id;
            document.getElementById('routeName').value = route.name || '';
            document.getElementById('routeDescription').value = route.description || '';
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
            this.listEl.innerHTML = this.stops.map((s, i) => `
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
        this.renderSummary();
        this.updateButtons();
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
                <span>${l.from_index + 1} → ${l.to_index + 1}</span>
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
