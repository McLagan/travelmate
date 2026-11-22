/**
 * TravelMate - "My Routes" on the profile page.
 * Lists saved routes; "Open on map" goes to /map#route=<id>, which the map page loads.
 */
(function () {
    function esc(t) {
        const d = document.createElement('div');
        d.textContent = t == null ? '' : String(t);
        return d.innerHTML;
    }

    async function api(method, path) {
        const token = localStorage.getItem('token');
        const resp = await fetch(`${window.CONFIG.API_BASE_URL}${path}`, {
            method, headers: { 'Authorization': `Bearer ${token}` },
        });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const text = await resp.text();
        return text ? JSON.parse(text) : null;
    }

    function stopsLine(r) {
        const w = r.waypoints || [];
        return w.map((p, i) => {
            const name = esc(String(p.name || '').split(',')[0]);
            const icon = { ferry: '⛴', flight: '✈' }[p.leg_mode];
            const ferry = i < w.length - 1 && icon ? ` <span title="${p.leg_mode}">${icon}</span>` : '';
            return name + ferry;
        }).join(' → ');
    }

    async function loadMyRoutes() {
        const box = document.getElementById('myRoutesList');
        if (!box || !localStorage.getItem('token')) return;
        try {
            const data = await api('GET', `/routes/?limit=100&_=${Date.now()}`);
            const routes = data.routes || [];
            const counter = document.getElementById('totalRoutes');
            if (counter) counter.textContent = data.total ?? routes.length;
            if (!routes.length) {
                box.innerHTML = `<div class="empty-state"><i class="fas fa-route"></i><p>No saved routes yet</p>
                    <p><small>Build a route on the map and press “Save Route”</small></p></div>`;
                return;
            }
            box.innerHTML = routes.map(r => `
                <div class="my-route">
                    <div class="my-route-main">
                        <b>${esc(r.name)}</b>
                        ${r.description ? `<div class="my-route-desc">${esc(r.description)}</div>` : ''}
                        <div class="my-route-stops">${(r.waypoints || []).length} stops: ${stopsLine(r)}</div>
                        <small>${new Date(r.created_at).toLocaleDateString()}</small>
                    </div>
                    <div class="my-route-actions">
                        <a class="btn btn-primary btn-sm" href="/map#route=${r.id}&open"><i class="fas fa-map"></i> Open on map</a>
                        <button class="btn btn-outline btn-sm" onclick="deleteMyRoute(${r.id})" title="Delete"><i class="fas fa-trash"></i></button>
                    </div>
                </div>`).join('');
        } catch (e) {
            box.innerHTML = `<div class="empty-state"><p>Could not load routes (${esc(e.message)})</p></div>`;
        }
    }

    window.deleteMyRoute = async function (id) {
        if (!confirm('Delete this route?')) return;
        try {
            await api('DELETE', `/routes/${id}`);
            loadMyRoutes();
        } catch (e) {
            alert('Failed to delete: ' + e.message);
        }
    };

    window.loadMyRoutes = loadMyRoutes;
    document.addEventListener('DOMContentLoaded', () => {
        loadMyRoutes();
        // profile.js fills the stats from the places count; overwrite with the real routes count after it
        setTimeout(loadMyRoutes, 1500);
    });
})();
