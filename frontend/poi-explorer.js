/**
 * TravelMate - places along the route (POST /routes/pois)
 *
 * Overrides the earlier POI functions from features.js:
 *  - searches along the real road through ALL stops of the route planner
 *  - shows score + the reasons for it, and stats of what each step filtered out
 *  - "Add" inserts the place as a stop into the right leg of the route
 */

const POI_STYLE = {
    sights:     { icon: '🏰', color: '#b45309' },
    museums:    { icon: '🏛️', color: '#7c3aed' },
    viewpoints: { icon: '🔭', color: '#0891b2' },
    nature:     { icon: '🌳', color: '#16a34a' },
    beaches:    { icon: '🏖️', color: '#0ea5e9' },
    family:     { icon: '🎡', color: '#db2777' },
    food:       { icon: '🍽️', color: '#ea580c' },
    castles:    { icon: '🏯', color: '#92400e' },
    archaeology:{ icon: '🏺', color: '#a16207' },
    religious:  { icon: '⛪', color: '#6d28d9' },
    wonders:    { icon: '⛰️', color: '#15803d' },
    spa:        { icon: '♨️', color: '#be123c' },
    wine:       { icon: '🍷', color: '#9f1239' },
};

window.poiState = { pois: [], layer: null };

function showPOIExplorer() {
    const rp = window.routePlanner;
    if (!rp || rp.stops.length < 2) {
        window.app?.showStatus('Add at least 2 stops first', 'error');
        return;
    }
    fillPOISections(rp);
    const m = document.getElementById('poiExplorerModal');
    m.style.display = 'flex';
    m.classList.add('active'); // .modal-overlay is hidden unless .active
}

// parts of the trip to search: days (between overnight stops), single legs, the whole trip
function poiSections(rp) {
    const n = rp.stops.length, days = rp.dayPlan(), legs = rp.lastPlan?.legs || [];
    const short = (i) => String(rp.stops[i].name).split(',')[0];
    const km = (a, b) => { let t = 0; for (let i = a; i < b; i++) t += legs[i]?.distance_km || 0; return Math.round(t); };
    const departDay = (i) => days.dayOf[i] + (rp.stops[i].stopType === 'overnight' ? (rp.stops[i].nights || 1) : 0);
    const out = { days: [], legs: [] };
    let a = 0;
    for (let i = 1; i < n; i++) {
        if (rp.stops[i].stopType === 'overnight' || i === n - 1) {
            out.days.push({ a, b: i, label: `Day ${departDay(a)}: ${short(a)} → ${short(i)}${legs.length ? ` · ${km(a, i)} km` : ''}` });
            a = i;
        }
    }
    for (let i = 0; i < n - 1; i++) {
        const mode = rp.stops[i].legMode || 'road';
        out.legs.push({ a: i, b: i + 1, label: `${i + 1} → ${i + 2}: ${short(i)} → ${short(i + 1)}${mode !== 'road' ? (mode === 'ferry' ? ' ⛴' : ' ✈') : ''}${legs.length ? ` · ${km(i, i + 1)} km` : ''}` });
    }
    return out;
}

function fillPOISections(rp) {
    const sel = document.getElementById('poiSection');
    if (!sel) return;
    const prev = sel.value;
    const s = poiSections(rp);
    const opt = (x) => `<option value="${x.a}-${x.b}">${escapeHtml(x.label)}</option>`;
    sel.innerHTML = (s.days.length > 1 ? `<optgroup label="Days">${s.days.map(opt).join('')}</optgroup>` : '')
        + `<optgroup label="Legs">${s.legs.map(opt).join('')}</optgroup>`
        + `<option value="0-${rp.stops.length - 1}">Whole trip (slow on long trips)</option>`;
    if ([...sel.options].some(o => o.value === prev)) sel.value = prev;
}

function closePOIExplorer() {
    const m = document.getElementById('poiExplorerModal');
    m.classList.remove('active');
    m.style.display = 'none';
}

function clearPOIMarkers() {
    if (window.poiState.layer) {
        window.app.map.removeLayer(window.poiState.layer);
        window.poiState.layer = null;
    }
}

function closePOIResults() {
    document.getElementById('poiResultsPanel').style.display = 'none';
    clearPOIMarkers();
}

async function searchPOIs() {
    const app = window.app, rp = window.routePlanner;
    if (!rp || rp.stops.length < 2) {
        app.showStatus('Add at least 2 stops first', 'error');
        return;
    }
    const categories = Array.from(document.querySelectorAll('#poiExplorerModal .poi-cats input:checked')).map(cb => cb.value);
    if (!categories.length) {
        app.showStatus('Pick at least one category', 'error');
        return;
    }
    const [a, b] = (document.getElementById('poiSection')?.value || `0-${rp.stops.length - 1}`).split('-').map(Number);
    const whole = a === 0 && b === rp.stops.length - 1;
    window.poiState.offset = a;  // leg numbers in the answer are relative to this part
    const body = {
        waypoints: rp.payload().slice(a, b + 1),
        profile: document.getElementById('transportMode')?.value || 'driving',
        categories,
        max_detour_minutes: parseInt(document.getElementById('poiTimeLimit').value, 10),
        mode: document.querySelector('input[name="poiMode"]:checked')?.value || 'top',
    };

    closePOIExplorer();
    app.showStatus(whole ? 'Searching the whole trip… (can take a few minutes)' : 'Searching places along this part… (10–40 s)', 'info');

    // Own fetch: this call is slower than the APIClient's default timeout
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), whole ? 300000 : 150000);
    try {
        const resp = await fetch(CONFIG.getEndpoint('/routes/pois'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${localStorage.getItem('token')}` },
            body: JSON.stringify(body),
            signal: controller.signal,
        });
        if (!resp.ok) {
            let detail = resp.statusText;
            try { detail = (await resp.json()).detail || detail; } catch (e) { /* ignore */ }
            throw new Error(`HTTP ${resp.status}: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`);
        }
        const data = await resp.json();
        window.poiState.pois = data.pois;
        renderPOIResults(data);
        renderPOIMarkers(data.pois);
        app.showStatus(`Found ${data.pois.length} places`, 'success');
    } catch (error) {
        app.showStatus(error.name === 'AbortError' ? 'Search took too long — pick one day or one leg' : `Place search failed: ${error.message}`, 'error');
    } finally {
        clearTimeout(timer);
    }
}

function poiDetourText(p) {
    return p.detour_source === 'road'
        ? `+${p.detour_minutes} min by road`
        : `~+${p.detour_minutes} min (est.)`;
}

function renderPOIStats(data) {
    const s = data.stats || {};
    const src = Object.entries(s.sources || {}).map(([name, v]) => {
        if (v.skipped) return `<span class="poi-src off" title="${escapeHtml(v.skipped)}">${name}: off</span>`;
        if (name === 'wikipedia') return `<span class="poi-src" title="${escapeHtml(v.role || '')}">wikipedia: ${v.articles_nearby} articles</span>`;
        if (name === 'wikidata') return `<span class="poi-src" title="${escapeHtml(v.role || '')}">wikidata: ${v.entities} popularity checks</span>`;
        return `<span class="poi-src">${name}: ${v.results}</span>`;
    }).join(' ');
    const funnel = `${s.candidates_raw ?? '?'} found → ${s.after_merge ?? '?'} after merging duplicates → ${s.within_detour ?? '?'} within ${data.max_detour_minutes} min → <b>${s.shown ?? '?'} shown</b>`;
    const errs = (s.errors || []).length
        ? `<div class="poi-err" title="${escapeHtml(s.errors.join('\n'))}">⚠ ${s.errors.length} request(s) failed — hover for details</div>` : '';
    return `<div>${funnel}</div><div class="poi-srcs">${src}</div>
            <div class="poi-meta">${s.route_km} km route · ${s.search_points} search circles of ${s.search_radius_km} km · ${s.seconds}s · mode: ${data.mode === 'top' ? 'highlights' : 'everything'}</div>${errs}`;
}

function mountPOIPanel() {
    // live inside the map area so the panel never grows past the map
    const panel = document.getElementById('poiResultsPanel');
    const host = document.querySelector('.map-container');
    if (panel && host && panel.parentElement !== host) host.appendChild(panel);
    if (panel && !panel.querySelector('.poi-min')) {
        const btn = document.createElement('button');
        btn.className = 'poi-min';
        btn.title = 'Collapse / expand';
        btn.innerHTML = '&#8212;';
        btn.onclick = () => panel.classList.toggle('collapsed');
        panel.querySelector('.poi-panel-head').appendChild(btn);
    }
}

function poiLinks(p) {
    const gmaps = `https://www.google.com/maps/search/?api=1&query=${p.lat},${p.lon}`;
    return [
        p.wikipedia_url ? `<a href="${p.wikipedia_url}" target="_blank" rel="noopener">Wikipedia</a>` : '',
        `<a href="${gmaps}" target="_blank" rel="noopener">Maps</a>`,
        p.website ? `<a href="${escapeHtml(p.website)}" target="_blank" rel="noopener">Website</a>` : '',
    ].filter(Boolean).join(' · ');
}

const _summaryCache = {};
async function loadPOISummary(p) {
    if (!p.wiki_lang || !p.wiki_title) return null;
    const key = `${p.wiki_lang}:${p.wiki_title}`;
    if (key in _summaryCache) return _summaryCache[key];
    try {
        _summaryCache[key] = await window.app.api.get('/locations/wiki-summary', { lang: p.wiki_lang, title: p.wiki_title });
    } catch (e) {
        _summaryCache[key] = null;
    }
    return _summaryCache[key];
}

function summaryHtml(sum) {
    if (!sum) return '<div class="poi-sum muted">No Wikipedia description — check Maps for photos and reviews.</div>';
    const text = sum.extract ? escapeHtml(sum.extract.length > 320 ? sum.extract.slice(0, 320) + '…' : sum.extract) : '';
    return `<div class="poi-sum">
        ${sum.thumbnail ? `<img src="${sum.thumbnail}" alt="" loading="lazy">` : ''}
        <div>${sum.description ? `<i>${escapeHtml(sum.description)}</i><br>` : ''}${text}</div>
    </div>`;
}

async function togglePOI(i) {
    const p = window.poiState.pois[i];
    const card = document.getElementById(`poi-${i}`);
    if (!p || !card) return;
    viewPOI(i);
    const open = card.classList.toggle('open');
    const box = card.querySelector('.poi-body');
    if (open && !box.dataset.loaded) {
        box.innerHTML = p.wiki_title ? '<div class="poi-sum muted">Loading…</div>' : summaryHtml(null);
        const sum = await loadPOISummary(p);
        box.innerHTML = summaryHtml(sum);
        box.dataset.loaded = '1';
    }
}

function renderPOIResults(data) {
    mountPOIPanel();
    const panel = document.getElementById('poiResultsPanel');
    const list = document.getElementById('poiList');
    panel.classList.remove('collapsed');
    document.getElementById('poiCount').textContent = data.pois.length;
    document.getElementById('poiStats').innerHTML = renderPOIStats(data);

    if (!data.pois.length) {
        list.innerHTML = `<p class="poi-empty">Nothing passed the filters. Try “Everything”, a longer detour or more categories.</p>`;
    } else {
        list.innerHTML = data.pois.map((p, i) => {
            const st = POI_STYLE[p.category] || POI_STYLE.sights;
            const langs = p.wiki_languages ? ` · 🌐 ${p.wiki_languages}` : '';
            return `
            <div class="poi-item" id="poi-${i}" onmouseenter="highlightPOI(${i})">
                <div class="poi-top" onclick="togglePOI(${i})">
                    ${p.thumb ? `<img class="poi-thumb" src="${escAttr(p.thumb)}" alt="" loading="lazy" referrerpolicy="no-referrer">`
                              : `<span class="poi-ico" style="background:${st.color}">${st.icon}</span>`}
                    <div class="poi-title">
                        <b title="${escapeHtml(p.local_name ? p.name + ' — ' + p.local_name : p.name)}">${escapeHtml(p.name)}</b>
                        <small>km ${p.route_km} · ${poiDetourText(p)}${langs}</small>
                        ${p.description ? `<small class="poi-desc">${escapeHtml(p.description)}</small>` : ''}
                    </div>
                    <span class="poi-score" title="Score — open “why” below">${p.score}</span>
                </div>
                <div class="poi-body"></div>
                <div class="poi-actions">
                    <span class="poi-links">${poiLinks(p)}</span>
                    <button class="poi-as-stop" onclick="addPOIAsStop(${i})" title="Make it a stop of the route (changes the route)">as stop</button>
                    <button class="poi-add" onclick="addPOIToRoute(${i})" title="Attach to the nearest stop, or to the leg if it is on the way — the route does not change">+ Add</button>
                </div>
                <details class="poi-why"><summary>why ${p.score}: ${p.sources.join(', ')}</summary>
                    <ul>${p.reasons.map(r => `<li>${escapeHtml(r)}</li>`).join('')}</ul>
                </details>
            </div>`;
        }).join('');
    }
    panel.style.display = 'flex';
}

function renderPOIMarkers(pois) {
    clearPOIMarkers();
    const layer = L.layerGroup();
    pois.forEach((p, i) => {
        const st = POI_STYLE[p.category] || POI_STYLE.sights;
        const m = L.marker([p.lat, p.lon], {
            icon: L.divIcon({
                className: 'poi-marker-wrap',
                html: `<div class="poi-marker" style="background:${st.color}">${st.icon}</div>`,
                iconSize: [26, 26], iconAnchor: [13, 13], popupAnchor: [0, -13],
            }),
        });
        const head = `<b>${escapeHtml(p.name)}</b><br><small>${poiDetourText(p)} · score ${p.score}</small>`;
        const foot = `<div class="poi-pop-foot">${poiLinks(p)}
            <button class="poi-add" onclick="addPOIToRoute(${i}); app.map.closePopup();">+ Add</button></div>`;
        m.bindPopup(`<div class="poi-pop">${head}<div class="poi-pop-body"></div>${foot}</div>`, { maxWidth: 300, minWidth: 240 });
        m.on('popupopen', async (e) => {
            const body = e.popup.getElement()?.querySelector('.poi-pop-body');
            if (!body || body.dataset.loaded) return;
            body.innerHTML = p.wiki_title ? '<div class="poi-sum muted">Loading…</div>' : '';
            const sum = await loadPOISummary(p);
            body.innerHTML = p.wiki_title ? summaryHtml(sum) : '';
            body.dataset.loaded = '1';
            e.popup.update();
        });
        p._marker = m;
        layer.addLayer(m);
    });
    layer.addTo(window.app.map);
    window.poiState.layer = layer;
}

function viewPOI(i) {
    const p = window.poiState.pois[i];
    if (!p) return;
    window.app.map.setView([p.lat, p.lon], Math.max(window.app.map.getZoom(), 13));
    p._marker?.openPopup();
}

function highlightPOI(i) {
    window.poiState.pois.forEach((p, j) => {
        const el = p._marker?.getElement();
        if (el) el.classList.toggle('poi-hl', i === j);
    });
}

const NEAR_STOP_KM = 10;  // closer than this to a stop of its leg -> it is a place to see at that stop

function poiSpot(p) {
    const url = [p.wikipedia_url, p.website].find(u => /^https?:\/\//i.test(u || ''));
    return { name: p.name, lat: p.lat, lng: p.lon, source: 'wiki', ref: p.wikidata || null, url: url || null,
             detour_min: p.detour_minutes != null ? Math.round(p.detour_minutes) : null };
}

// where a found place belongs: [kind, index] - ('stop', i) near a stop, ('leg', i) on the way from stop i
function poiTarget(p, rp) {
    const g = Math.min((window.poiState.offset || 0) + (p.leg_index ?? 0), rp.stops.length - 2);
    const a = rp.stops[g], b = rp.stops[g + 1];
    const d = (s) => L.latLng(s.lat, s.lng).distanceTo(L.latLng(p.lat, p.lon)) / 1000;
    const da = d(a), db = d(b);
    if (Math.min(da, db) <= NEAR_STOP_KM) return da <= db ? ['stop', g] : ['stop', g + 1];
    return ['leg', g];
}

// "+ Add": a sight is attached to a stop or to the leg, the route itself does not change
function addPOIToRoute(i) {
    const p = window.poiState.pois[i];
    const rp = window.routePlanner;
    if (!p || !rp || rp.stops.length < 2) return;
    const [kind, k] = poiTarget(p, rp);
    const short = (j) => String(rp.stops[j].name).split(',')[0];
    if (kind === 'stop') {
        rp.addSpot(k, poiSpot(p));
        window.app.showStatus(`“${p.name}” added to stop ${k + 1} (${short(k)})`, 'success');
    } else {
        rp.addLegSpot(k, poiSpot(p));
        window.app.showStatus(`“${p.name}” added on the way ${short(k)} → ${short(k + 1)}`, 'success');
    }
    markPOIAdded(i);
}

// old behaviour, on request: make the place a real stop of the route
function addPOIAsStop(i) {
    const p = window.poiState.pois[i];
    const rp = window.routePlanner;
    if (!p || !rp) return;
    const index = Math.min((window.poiState.offset || 0) + (p.leg_index ?? rp.stops.length - 2) + 1, rp.stops.length - 1);
    rp.addStop(p.lat, p.lon, p.name, index);
    window.app.showStatus(`Added “${p.name}” as stop ${index + 1}`, 'success');
}

function markPOIAdded(i) {
    document.querySelectorAll(`#poi-${i} .poi-add`).forEach(b => { b.textContent = '✓ Added'; b.classList.add('added'); });
}

// override old implementations from features.js
window.showPOIExplorer = showPOIExplorer;
window.closePOIExplorer = closePOIExplorer;
window.closePOIResults = closePOIResults;
window.searchPOIs = searchPOIs;
window.addPOIToRoute = addPOIToRoute;
window.addPOIAsStop = addPOIAsStop;
window.viewPOI = viewPOI;
window.highlightPOI = highlightPOI;
window.togglePOI = togglePOI;
document.addEventListener('DOMContentLoaded', () => setTimeout(mountPOIPanel, 0));
