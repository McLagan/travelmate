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
};

window.poiState = { pois: [], layer: null };

function showPOIExplorer() {
    const rp = window.routePlanner;
    if (!rp || rp.stops.length < 2) {
        window.app?.showStatus('Add at least 2 stops first', 'error');
        return;
    }
    const m = document.getElementById('poiExplorerModal');
    m.style.display = 'flex';
    m.classList.add('active'); // .modal-overlay is hidden unless .active
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
    const body = {
        waypoints: rp.payload(),
        profile: document.getElementById('transportMode')?.value || 'driving',
        categories,
        max_detour_minutes: parseInt(document.getElementById('poiTimeLimit').value, 10),
        mode: document.querySelector('input[name="poiMode"]:checked')?.value || 'top',
    };

    closePOIExplorer();
    app.showStatus('Searching places along the route… (can take 10–40 s on long routes)', 'info');

    // Own fetch: this call is slower than the APIClient's default timeout
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 120000);
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
        app.errorHandler.handle(error.name === 'AbortError' ? new Error('Search timed out') : error, 'Place search failed');
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
                    <span class="poi-ico" style="background:${st.color}">${st.icon}</span>
                    <div class="poi-title">
                        <b title="${escapeHtml(p.name)}">${escapeHtml(p.name)}</b>
                        <small>km ${p.route_km} · ${poiDetourText(p)}${langs}</small>
                    </div>
                    <span class="poi-score" title="Score — open “why” below">${p.score}</span>
                </div>
                <div class="poi-body"></div>
                <div class="poi-actions">
                    <span class="poi-links">${poiLinks(p)}</span>
                    <button class="poi-add" onclick="addPOIToRoute(${i})" title="Add as a stop">+ Add</button>
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

function addPOIToRoute(i) {
    const p = window.poiState.pois[i];
    const rp = window.routePlanner;
    if (!p || !rp) return;
    // insert between the two stops of the leg the place is on
    const index = Math.min((p.leg_index ?? rp.stops.length - 2) + 1, rp.stops.length - 1);
    rp.addStop(p.lat, p.lon, p.name, index);
    window.app.showStatus(`Added “${p.name}” as stop ${index + 1}`, 'success');
}

// override old implementations from features.js
window.showPOIExplorer = showPOIExplorer;
window.closePOIExplorer = closePOIExplorer;
window.closePOIResults = closePOIResults;
window.searchPOIs = searchPOIs;
window.addPOIToRoute = addPOIToRoute;
window.viewPOI = viewPOI;
window.highlightPOI = highlightPOI;
window.togglePOI = togglePOI;
document.addEventListener('DOMContentLoaded', () => setTimeout(mountPOIPanel, 0));
