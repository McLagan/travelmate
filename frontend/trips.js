/**
 * TravelMate - "My Trips": all saved trips as cards (dates, days, nights, lodging budget).
 */
(function () {
    const esc = t => { const d = document.createElement('div'); d.textContent = t == null ? '' : String(t); return d.innerHTML; };
    const token = () => localStorage.getItem('token');

    async function api(method, path) {
        const r = await fetch(`${window.CONFIG.API_BASE_URL}${path}`, { method, headers: { Authorization: `Bearer ${token()}` } });
        if (r.status === 401) { location.href = '/map'; return null; }
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const t = await r.text();
        return t ? JSON.parse(t) : null;
    }

    function summary(r) {
        const w = r.waypoints || [];
        const nights = w.reduce((a, p) => a + (p.stop_type === 'overnight' ? (p.nights || 1) : 0), 0);
        const lodging = {};
        w.forEach(p => { if (p.stop_type === 'overnight' && p.lodging_price) { const c = p.lodging_currency || 'EUR'; lodging[c] = (lodging[c] || 0) + p.lodging_price; } });
        let dates = '';
        if (r.start_date) {
            const s = new Date(r.start_date + 'T12:00:00');
            const e = new Date(s); e.setDate(e.getDate() + nights);
            const f = d => d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
            dates = nights ? `${f(s)} – ${f(e)}` : f(s);
        }
        const modes = new Set(w.slice(0, -1).map(p => p.leg_mode));
        // costs entered by hand (fuel is not included: it needs the calculated road distance)
        const costs = {};
        const add = (v, c) => { if (v) { c = c || 'EUR'; costs[c] = (costs[c] || 0) + v; } };
        w.forEach((p, i) => {
            if (p.stop_type === 'overnight') add(p.lodging_price, p.lodging_currency);
            if (i < w.length - 1) add(p.leg_cost, p.leg_currency);
            [...(p.spots || []), ...(p.leg_spots || [])].forEach(x => add(x.cost, x.currency));
        });
        (r.extras || []).forEach(e => add(e.amount, e.currency));
        const bookings = [];
        w.forEach((p, i) => {
            if (p.stop_type === 'overnight') bookings.push(!!p.lodging_booked);
            if (i < w.length - 1 && (p.leg_mode === 'ferry' || p.leg_mode === 'flight')) bookings.push(!!p.leg_booked);
        });
        const spots = w.reduce((a, p) => a + (p.spots || []).length + (p.leg_spots || []).length, 0);
        return { nights, days: nights + 1, lodging, costs, bookings, spots, dates, modes, overnights: w.filter(p => p.stop_type === 'overnight').map(p => String(p.name).split(',')[0]) };
    }

    async function load() {
        const box = document.getElementById('tripsList');
        if (!token()) { box.innerHTML = '<div class="empty-state"><p>Sign in on the <a href="/map">map page</a> to see your trips.</p></div>'; return; }
        try {
            const data = await api('GET', `/routes/?limit=100&_=${Date.now()}`);
            const trips = data?.routes || [];
            if (!trips.length) {
                box.innerHTML = '<div class="empty-state"><i class="fas fa-suitcase"></i><p>No trips yet</p><p><a href="/map#new">Plan your first trip</a></p></div>';
                return;
            }
            box.innerHTML = trips.map(r => {
                const s = summary(r);
                const icons = [...s.modes].map(m => ({ ferry: '⛴', flight: '✈' }[m] || '')).join(' ');
                const costs = Object.entries(s.costs).map(([c, v]) => `${Math.round(v).toLocaleString()} ${c}`).join(' + ');
                const booked = s.bookings.filter(Boolean).length;
                const chain = (r.waypoints || []).map(p => esc(String(p.name).split(',')[0])).join(' → ');
                return `
                <div class="trip-card">
                    <div class="trip-top">
                        <h3>${esc(r.name)}</h3>
                        <span class="trip-icons">🚗 ${icons}</span>
                    </div>
                    <div class="trip-dates">${s.dates ? esc(s.dates) : '<span class="muted">no dates yet</span>'}</div>
                    <div class="trip-stats">
                        <span><b>${(r.waypoints || []).length}</b> stops</span>
                        ${s.nights ? `<span><b>${s.days}</b> days · <b>${s.nights}</b> night${s.nights > 1 ? 's' : ''}</span>` : ''}
                        ${s.spots ? `<span>★ <b>${s.spots}</b> places</span>` : ''}
                    </div>
                    <div class="trip-stats">
                        ${costs ? `<span title="Lodging, tickets, places and other costs entered (fuel not included)">💶 <b>${esc(costs)}</b></span>` : ''}
                        ${s.bookings.length ? `<span class="${booked === s.bookings.length ? 'trip-ok' : ''}">✅ booked <b>${booked}/${s.bookings.length}</b></span>` : ''}
                    </div>
                    ${s.overnights.length ? `<div class="trip-sleep">Nights in: ${s.overnights.map(esc).join(', ')}</div>` : ''}
                    <div class="trip-chain">${chain}</div>
                    ${r.description ? `<div class="trip-desc">${esc(r.description)}</div>` : ''}
                    <div class="trip-actions">
                        <a class="btn btn-primary btn-sm" href="/trip?id=${r.id}"><i class="fas fa-suitcase"></i> Open</a>
                        <a class="btn btn-outline btn-sm" href="/map#route=${r.id}&open" title="Edit the route on the map"><i class="fas fa-map"></i> Map</a>
                        <button class="btn btn-outline btn-sm" onclick="deleteTrip(${r.id})" title="Delete"><i class="fas fa-trash"></i></button>
                    </div>
                </div>`;
            }).join('');
        } catch (e) {
            box.innerHTML = `<div class="empty-state"><p>Could not load trips (${esc(e.message)})</p></div>`;
        }
    }

    window.deleteTrip = async id => {
        if (!confirm('Delete this trip?')) return;
        try { await api('DELETE', `/routes/${id}`); load(); } catch (e) { alert('Failed: ' + e.message); }
    };
    window.logout = () => { localStorage.removeItem('token'); location.href = '/map'; };

    document.addEventListener('DOMContentLoaded', async () => {
        try {
            const me = await api('GET', '/auth/me');
            if (me) document.getElementById('userName').textContent = me.name;
        } catch (e) { /* ignore */ }
        load();
    });
})();
