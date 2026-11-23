/**
 * TravelMate - "My cars": list + add / edit / delete (GET/POST/PUT/DELETE /cars).
 * Used on the profile page and on the trip page (tab "Car & fuel").
 */
const CarsUI = {
    FUELS: { petrol: '⛽ Petrol', diesel: '⛽ Diesel', lpg: '🟢 LPG', hybrid: '🔋 Hybrid (petrol)', electric: '⚡ Electric' },
    cars: [],

    async api(method, path, body) {
        const r = await fetch(`${window.CONFIG.API_BASE_URL}${path}`, {
            method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${localStorage.getItem('token')}` },
            body: body ? JSON.stringify(body) : undefined,
        });
        if (!r.ok) {
            let d = `HTTP ${r.status}`;
            try { const j = await r.json(); d = typeof j.detail === 'string' ? j.detail : JSON.stringify(j.detail); } catch (e) { /* ignore */ }
            throw new Error(d);
        }
        return r.status === 204 ? null : r.json();
    },

    async load() {
        this.cars = await this.api('GET', '/cars');
        return this.cars;
    },

    unit(c) { return c.fuel_type === 'electric' ? 'kWh/100 km' : 'L/100 km'; },

    label(c) {
        const what = [c.make, c.model, c.year].filter(Boolean).join(' ');
        return `${c.name}${what ? ` (${what})` : ''}${c.consumption ? ` · ${c.consumption} ${this.unit(c)}` : ''}`;
    },

    // el: container; opts.onChange(cars) after any change
    async mount(el, opts = {}) {
        this.el = el;
        this.opts = opts;
        try { await this.load(); } catch (e) { el.innerHTML = `<div class="ferry-msg err">Could not load cars: ${escapeHtml(e.message)}</div>`; return; }
        this.render();
    },

    render(editId = null) {
        const el = this.el;
        if (!el) return;
        const form = (c = {}) => `
            <form class="car-form" onsubmit="event.preventDefault(); CarsUI.save(this, ${c.id || 'null'})">
                <div class="car-grid">
                    <label>Name<input class="on-input" name="name" required maxlength="80" value="${escAttr(c.name || '')}" placeholder="Our Škoda"></label>
                    <label>Make<input class="on-input" name="make" maxlength="60" value="${escAttr(c.make || '')}" placeholder="Škoda"></label>
                    <label>Model<input class="on-input" name="model" maxlength="60" value="${escAttr(c.model || '')}" placeholder="Octavia 2.0 TDI"></label>
                    <label>Year<input class="on-input" name="year" type="number" min="1950" max="2100" value="${c.year ?? ''}"></label>
                    <label>Fuel<select class="on-input" name="fuel_type">${Object.entries(this.FUELS).map(([k, v]) => `<option value="${k}" ${k === (c.fuel_type || 'petrol') ? 'selected' : ''}>${v}</option>`).join('')}</select></label>
                    <label>Consumption, real life<input class="on-input" name="consumption" inputmode="decimal" required value="${c.consumption ?? ''}" placeholder="6.5"><small>L/100 km (kWh for electric)</small></label>
                    <label>Tank, L<input class="on-input" name="tank_l" inputmode="decimal" value="${c.tank_l ?? ''}" placeholder="50"></label>
                    <label class="car-notes">Notes<input class="on-input" name="notes" maxlength="1000" value="${escAttr(c.notes || '')}" placeholder="roof box, vignette class…"></label>
                </div>
                <div class="on-row">
                    <button class="btn btn-primary btn-sm" type="submit">${c.id ? 'Save' : 'Add car'}</button>
                    ${c.id || this.cars.length ? `<button class="wp-link" type="button" onclick="CarsUI.render()">Cancel</button>` : ''}
                </div>
            </form>`;
        const list = this.cars.map(c => c.id === editId ? form(c) : `
            <div class="car-row">
                <span class="car-ico">${c.fuel_type === 'electric' ? '⚡' : '🚗'}</span>
                <span class="car-label">${escapeHtml(this.label(c))}</span>
                <button class="wp-link" onclick="CarsUI.render(${c.id})">Edit</button>
                <button class="wp-btn wp-del" title="Delete" onclick="CarsUI.remove(${c.id})"><i class="fas fa-times"></i></button>
            </div>`).join('');
        el.innerHTML = `${list || '<div class="pp-empty">No cars yet.</div>'}
            ${editId === 'new' || !this.cars.length ? form() : (editId === null ? '<button class="wp-link" onclick="CarsUI.render(\'new\')">+ Add a car</button>' : '')}`;
    },

    async save(f, id) {
        const num = (v) => { const n = parseFloat(String(v).replace(',', '.')); return isNaN(n) ? null : n; };
        const body = {
            name: f.name.value.trim(), make: f.make.value.trim() || null, model: f.model.value.trim() || null,
            year: f.year.value ? parseInt(f.year.value, 10) : null, fuel_type: f.fuel_type.value,
            consumption: num(f.consumption.value), tank_l: num(f.tank_l.value), notes: f.notes.value.trim() || null,
        };
        try {
            await this.api(id ? 'PUT' : 'POST', id ? `/cars/${id}` : '/cars', body);
            await this.load();
            this.render();
            this.opts.onChange?.(this.cars);
        } catch (e) {
            alert(`Could not save the car: ${e.message}`);
        }
    },

    async remove(id) {
        if (!confirm('Delete this car?')) return;
        try {
            await this.api('DELETE', `/cars/${id}`);
            await this.load();
            this.render();
            this.opts.onChange?.(this.cars);
        } catch (e) {
            alert(`Could not delete: ${e.message}`);
        }
    },
};

window.CarsUI = CarsUI;
