/**
 * TravelMate - "Popular here" for one stop of the trip.
 *
 * Opens a panel over the map with
 *  - spots shared by travellers (public user places) and your own spots,
 *  - the most notable places around the stop (Wikipedia/Wikidata popularity, Geoapify, OpenTripMap),
 * and lets you pick places into the stop (★ in the stop list, star on the map)
 * or share a spot of your own (name, photo, exact point on the map).
 */
const StopPlaces = {
    i: null,            // index of the stop the panel is open for
    data: null,         // last /routes/popular answer
    layer: null,        // result markers
    pickMarker: null,   // where the new own spot will be
    cats: ['sights', 'museums', 'viewpoints', 'nature'],
    radius: 6,
    seq: 0,

    CAT_LABELS: { sights: 'Sights', castles: 'Castles', archaeology: 'Ruins', religious: 'Churches', museums: 'Museums',
                  viewpoints: 'Views', nature: 'Nature', wonders: 'Caves & peaks', beaches: 'Beaches', spa: 'Thermal', wine: 'Wine',
                  food: 'Food', family: 'Family' },

    get rp() { return window.routePlanner; },
    get map() { return window.app?.map; },

    panel() {
        let el = document.getElementById('popularPanel');
        if (!el) {
            el = document.createElement('div');
            el.id = 'popularPanel';
            el.className = 'popular-panel';
            document.body.appendChild(el);
        }
        return el;
    },

    // center: optional {lat, lng, name} - search around a picked place instead of the stop itself;
    // results are still added to stop i
    async open(i, center = null) {
        const stop = this.rp?.stops[i];
        if (!stop) return;
        this.i = i;
        this.center = center ? { lat: +center.lat, lng: +center.lng, name: center.name } : { lat: stop.lat, lng: stop.lng, name: stop.name };
        this.data = null;
        this.cancelPick();
        const el = this.panel();
        el.style.display = 'flex';
        el.innerHTML = `
            <div class="pp-head">
                <div><div class="pp-title">★ Popular ${center ? 'around' : 'in'} ${escapeHtml(String(this.center.name).split(',')[0])}</div>
                     <div class="pp-sub">picked places go to stop ${i + 1} · ${escapeHtml(String(stop.name).split(',')[0])}</div></div>
                <button class="pp-close" onclick="StopPlaces.close()" title="Close">×</button>
            </div>
            <div class="pp-filters">
                ${Object.entries(this.CAT_LABELS).map(([k, v]) => `<button class="pp-cat ${this.cats.includes(k) ? 'on' : ''}" onclick="StopPlaces.toggleCat('${k}')">${v}</button>`).join('')}
                <select class="pp-radius" onchange="StopPlaces.setRadius(this.value)" title="Search radius">
                    ${[2, 4, 6, 10].map(r => `<option value="${r}" ${r === this.radius ? 'selected' : ''}>${r} km</option>`).join('')}
                </select>
            </div>
            <div class="pp-body" id="ppBody"><div class="pp-msg"><i class="fas fa-spinner fa-spin"></i> Looking around… (10–30 s the first time)</div></div>`;
        this.map?.setView([this.center.lat, this.center.lng], 13);
        await this.load();
    },

    close() {
        this.cancelPick();
        const el = document.getElementById('popularPanel');
        if (el) el.style.display = 'none';
        if (this.layer) this.layer.clearLayers();
        this.i = null;
    },

    toggleCat(k) {
        this.cats = this.cats.includes(k) ? this.cats.filter(c => c !== k) : [...this.cats, k];
        if (!this.cats.length) this.cats = [k];
        if (this.i !== null) this.open(this.i, this.centerArg());
    },

    centerArg() {
        const stop = this.rp?.stops[this.i];
        return stop && (this.center.lat !== stop.lat || this.center.lng !== stop.lng) ? this.center : null;
    },

    setRadius(v) {
        this.radius = parseInt(v, 10) || 6;
        if (this.i !== null) this.open(this.i, this.centerArg());
    },

    async load() {
        const c = this.center;
        const seq = ++this.seq;
        try {
            const res = await window.app.api.get('/routes/popular', {
                lat: c.lat, lon: c.lng, radius_km: this.radius, categories: this.cats.join(','), _: Date.now(),
            });
            if (seq !== this.seq) return;
            this.data = res;
            this.renderList();
        } catch (e) {
            if (seq !== this.seq) return;
            const body = document.getElementById('ppBody');
            if (body) body.innerHTML = `<div class="pp-msg err">Search failed: ${escapeHtml(e.message || String(e))}</div>`;
        }
    },

    // ----- list -----

    wikiSpot(m) {
        const url = [m.wikipedia_url, m.website].find(u => /^https?:\/\//i.test(u || ''));
        return { name: m.name, lat: m.lat, lng: m.lon, source: 'wiki', ref: m.wikidata || null, url: url || null };
    },

    communitySpot(p) {
        return { name: p.name, lat: p.lat, lng: p.lon, source: p.mine ? 'mine' : 'community', ref: String(p.id),
                 url: /^https?:\/\//i.test(p.website || '') ? p.website : null };
    },

    renderList() {
        const body = document.getElementById('ppBody');
        if (!body || !this.data) return;
        const places = this.data.places || [];
        const community = this.data.community || [];
        const errs = (this.data.stats?.errors || []);

        const commHtml = community.length ? community.map((p, k) => this.itemHtml({
            idx: `c${k}`, spot: this.communitySpot(p), name: p.name, photo: p.photo ? this.photoUrl(p.photo) : null,
            desc: p.description, meta: `${p.mine ? 'your spot' : 'shared by a traveller'}${p.mine && !p.is_public ? ' · private' : ''} · ${p.distance_km} km`,
            link: p.website,
        })).join('') : `<div class="pp-empty">Nobody has shared a spot here yet.</div>`;

        const popHtml = places.length ? places.map((m, k) => this.itemHtml({
            idx: `p${k}`, spot: this.wikiSpot(m), name: m.name, photo: m.thumb, desc: m.description,
            meta: [m.wiki_languages ? `Wikipedia in ${m.wiki_languages} lang.` : 'no Wikipedia article',
                   m.unesco ? 'UNESCO' : (m.heritage ? 'heritage' : ''), `${m.distance_km} km`].filter(Boolean).join(' · '),
            link: m.wikipedia_url || m.website, score: m.score, reasons: m.reasons,
        })).join('') : `<div class="pp-empty">Nothing notable found — try a bigger radius or other categories.</div>`;

        body.innerHTML = `
            <div class="pp-section">
                <div class="pp-sec-head"><span>👣 From travellers</span>
                    <button class="wp-link" onclick="StopPlaces.showShareForm()">+ Share a spot</button></div>
                <div id="ppShare"></div>
                ${commHtml}
            </div>
            <div class="pp-section">
                <div class="pp-sec-head"><span>★ Popular</span><span class="pp-note" title="Ranked by how many Wikipedia language editions describe the place, plus heritage/UNESCO and number of sources">by Wikipedia popularity</span></div>
                ${popHtml}
            </div>
            ${errs.length ? `<div class="pp-note err" title="${escAttr(errs.join('\n'))}">Some sources failed (${errs.length}) — results may be incomplete</div>` : ''}`;
        this.drawMarkers(community, places);
    },

    itemHtml({ idx, spot, name, photo, desc, meta, link, score, reasons }) {
        const key = spotKey(spot);
        const added = this.rp.hasSpot(this.i, key);
        this._spots = this._spots || {};
        this._spots[idx] = spot;
        return `
            <div class="pp-item ${added ? 'added' : ''}" id="pp-${idx}" onmouseenter="StopPlaces.hover('${idx}')">
                ${photo ? `<img class="pp-photo" src="${escAttr(photo)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : '<div class="pp-photo pp-nophoto">📍</div>'}
                <div class="pp-info">
                    <div class="pp-name">${escapeHtml(name)}${score !== undefined ? ` <span class="pp-score" title="${escAttr((reasons || []).join('\n'))}">${score}</span>` : ''}</div>
                    ${desc ? `<div class="pp-desc">${escapeHtml(String(desc).slice(0, 160))}</div>` : ''}
                    <div class="pp-meta">${escapeHtml(meta)}${/^https?:\/\//i.test(link || '') ? ` · <a href="${escAttr(link)}" target="_blank" rel="noopener">open ↗</a>` : ''}</div>
                </div>
                <button class="pp-add" onclick="StopPlaces.toggle('${idx}')" title="${added ? 'Remove from this stop' : 'Add to this stop'}">${added ? '✓' : '+'}</button>
            </div>`;
    },

    photoUrl(u) {
        if (/^https?:\/\//i.test(u)) return u;
        return `${window.CONFIG.API_BASE_URL}${u.startsWith('/') ? '' : '/'}${u}`;
    },

    toggle(idx) {
        const spot = this._spots?.[idx];
        if (!spot || this.i === null) return;
        const key = spotKey(spot);
        if (this.rp.hasSpot(this.i, key)) this.rp.removeSpotByKey(this.i, key);
        else this.rp.addSpot(this.i, { ...spot });
        this.renderList();
    },

    drawMarkers(community, places) {
        if (!this.map) return;
        if (this.layer) this.layer.clearLayers();
        else this.layer = L.layerGroup().addTo(this.map);
        const add = (lat, lon, idx, label, cls) => {
            L.marker([lat, lon], {
                icon: L.divIcon({ className: 'pp-marker-wrap', html: `<div class="pp-marker ${cls}">${label}</div>`, iconSize: [24, 24], iconAnchor: [12, 12] }),
            }).on('click', () => this.reveal(idx)).addTo(this.layer);
        };
        community.forEach((p, k) => add(p.lat, p.lon, `c${k}`, '👣', 'comm'));
        places.forEach((m, k) => add(m.lat, m.lon, `p${k}`, k + 1, 'pop'));
    },

    hover(idx) {
        document.querySelectorAll('.pp-item.hl').forEach(e => e.classList.remove('hl'));
        document.getElementById(`pp-${idx}`)?.classList.add('hl');
    },

    reveal(idx) {
        const el = document.getElementById(`pp-${idx}`);
        if (!el) return;
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        this.hover(idx);
    },

    // ----- share a spot of your own -----

    showShareForm() {
        const box = document.getElementById('ppShare');
        const stop = this.rp.stops[this.i];
        if (!box || !stop) return;
        this.newPoint = { lat: this.center.lat, lng: this.center.lng };
        box.innerHTML = `
            <form class="pp-share" onsubmit="event.preventDefault(); StopPlaces.submitShare(this)">
                <input class="on-input" name="name" placeholder="What is it? (e.g. a quiet viewpoint above the lake)" required maxlength="200">
                <textarea class="on-input" name="description" rows="2" placeholder="Why go, how to get there, best time…" maxlength="2000"></textarea>
                <div class="on-row">
                    <select class="on-cur" name="category">
                        ${['attraction', 'viewpoint', 'nature', 'beach', 'food', 'other'].map(c => `<option>${c}</option>`).join('')}
                    </select>
                    <input type="file" name="photo" accept="image/*" class="pp-file">
                </div>
                <div class="pp-where" id="ppWhere">📍 Point: at the stop. <button type="button" class="wp-link" onclick="StopPlaces.startPick()">Click on the map to set the exact spot</button></div>
                <label class="booked-chk"><input type="checkbox" name="is_public" checked> share with other travellers</label>
                <div class="on-row">
                    <button class="btn btn-primary btn-sm" type="submit">Save spot</button>
                    <button class="wp-link" type="button" onclick="StopPlaces.hideShareForm()">Cancel</button>
                </div>
            </form>`;
    },

    hideShareForm() {
        this.cancelPick();
        const box = document.getElementById('ppShare');
        if (box) box.innerHTML = '';
    },

    startPick() {
        if (!this.map) return;
        this.map.getContainer().style.cursor = 'crosshair';
        const where = document.getElementById('ppWhere');
        if (where) where.innerHTML = '📍 Now click on the map…';
        this._pickHandler = (e) => {
            this.map.getContainer().style.cursor = '';
            this.setPoint(e.latlng.lat, e.latlng.lng);
            this.map.off('click', this._pickHandler);
            this._pickHandler = null;
        };
        this.map.on('click', this._pickHandler);
    },

    setPoint(lat, lng) {
        this.newPoint = { lat: +lat.toFixed(6), lng: +lng.toFixed(6) };
        if (this.pickMarker) this.pickMarker.setLatLng([lat, lng]);
        else {
            this.pickMarker = L.marker([lat, lng], { draggable: true,
                icon: L.divIcon({ className: 'pp-marker-wrap', html: '<div class="pp-marker comm new">👣</div>', iconSize: [26, 26], iconAnchor: [13, 13] }) })
                .on('dragend', e => { const p = e.target.getLatLng(); this.newPoint = { lat: +p.lat.toFixed(6), lng: +p.lng.toFixed(6) }; this.showPoint(); })
                .addTo(this.map);
        }
        this.showPoint();
    },

    showPoint() {
        const where = document.getElementById('ppWhere');
        if (where) where.innerHTML = `📍 ${this.newPoint.lat.toFixed(5)}, ${this.newPoint.lng.toFixed(5)} (drag the marker to adjust)
            <button type="button" class="wp-link" onclick="StopPlaces.startPick()">pick again</button>`;
    },

    cancelPick() {
        if (this._pickHandler && this.map) {
            this.map.off('click', this._pickHandler);
            this.map.getContainer().style.cursor = '';
        }
        this._pickHandler = null;
        if (this.pickMarker && this.map) this.map.removeLayer(this.pickMarker);
        this.pickMarker = null;
    },

    async submitShare(form) {
        const fd = new FormData();
        fd.append('name', form.name.value.trim());
        fd.append('description', form.description.value.trim());
        fd.append('category', form.category.value);
        fd.append('latitude', String(this.newPoint.lat));
        fd.append('longitude', String(this.newPoint.lng));
        fd.append('website', '');
        fd.append('is_public', form.is_public.checked ? 'true' : 'false');
        fd.append('customFields', '[]');
        if (form.photo.files[0]) fd.append('photo', form.photo.files[0]);
        const btn = form.querySelector('button[type=submit]');
        if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }
        try {
            const r = await fetch(`${window.CONFIG.API_BASE_URL}/profile/places`, {
                method: 'POST', headers: { Authorization: `Bearer ${localStorage.getItem('token')}` }, body: fd,
            });
            if (!r.ok) throw new Error(`HTTP ${r.status}`);
            const place = await r.json();
            this.rp.addSpot(this.i, { name: place.name, lat: place.latitude, lng: place.longitude, source: 'mine', ref: String(place.id), url: null });
            this.hideShareForm();
            window.app.showStatus(`Spot "${place.name}" saved${place.is_public ? ' and shared' : ''}`, 'success');
            await this.load();
        } catch (e) {
            if (btn) { btn.disabled = false; btn.textContent = 'Save spot'; }
            window.app.showStatus(`Could not save the spot (${e.message})`, 'error');
        }
    },
};

window.StopPlaces = StopPlaces;
