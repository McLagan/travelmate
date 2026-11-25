/**
 * TravelMate - trip budget & bookings (under the route summary).
 *
 *  ⛽ fuel     = road km of the route × L/100 km × fuel price
 *  ⛴✈ tickets = costs entered on ferry / flight legs
 *  🛏 lodging  = prices of overnight stays
 *  ★ places   = costs entered on places picked at stops
 *  ➕ other    = free list (insurance, vignettes, food…)
 *
 * Amounts stay in the currency they were entered in; totals are converted to the
 * chosen currency with daily rates (GET /routes/rates). Without a rate the amount
 * is shown separately and not converted.
 */
const TripBudget = {
    open: false,
    rates: {},      // base -> {rates} | 'loading' | 'error'

    el() { return document.getElementById('tripBudget'); },

    fmt(n) { return Math.round(n).toLocaleString(); },

    ensureRates(base, rp) {
        if (this.rates[base]) return;
        this.rates[base] = 'loading';
        window.app.api.get('/routes/rates', { base })
            .then(r => { this.rates[base] = r; })
            .catch(() => { this.rates[base] = 'error'; })
            .finally(() => this.render(rp));
    },

    // [{amount, cur}] -> {total (in base), rest: {cur: amount}} ; rest = amounts without a rate
    sum(items, base) {
        const r = this.rates[base];
        const table = r && typeof r === 'object' ? r.rates : null;
        let total = 0;
        const rest = {}, byCur = {};
        items.forEach(({ amount, cur }) => {
            if (!amount) return;
            cur = cur || base;
            byCur[cur] = (byCur[cur] || 0) + amount;
            if (cur === base) total += amount;
            else if (table && table[cur]) total += amount / table[cur];
            else rest[cur] = (rest[cur] || 0) + amount;
        });
        return { total, rest, byCur };
    },

    amountHtml(s, base) {
        const rest = Object.entries(s.rest).map(([c, v]) => `${this.fmt(v)} ${escapeHtml(c)}`);
        const orig = Object.entries(s.byCur).map(([c, v]) => `${this.fmt(v)} ${c}`).join(' + ');
        const main = s.total || !rest.length ? `${Object.keys(s.byCur).some(c => c !== base) ? '≈ ' : ''}${this.fmt(s.total)} ${escapeHtml(base)}` : '';
        return `<span title="${escAttr(orig || '0')}">${[main, ...rest].filter(Boolean).join(' + ')}</span>`;
    },

    // what makes up the vignette / toll line: what to buy, where, for which days
    tollsHtml(te) {
        const roads = te?.road_tolls || [];
        if (!te || (!te.vignettes.length && !te.crossings.length && !roads.length)) return '';
        const days = (a, b) => a === b ? `day ${a}` : `days ${a}–${b}`;
        const eur = (n) => (Math.round(n * 100) / 100).toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 });
        const v = te.vignettes.map(x => `<li><b>${escapeHtml(x.country)}</b>: ${x.chosen.map(o => `${escapeHtml(o.name)} (${days(o.first_day, o.last_day)}) ${eur(o.price_eur)} €`).join(' + ')}
            ${x.url ? ` · <a href="${escAttr(x.url)}" target="_blank" rel="noopener">buy ↗</a>` : ''}${x.verified ? ` <small class="muted">price checked ${escapeHtml(x.verified)}</small>` : ''}</li>`).join('');
        const t = te.crossings.map(x => `<li>${x.type === 'bridge' ? '🌉' : '🚇'} ${escapeHtml(x.name)} <small class="muted">(${escapeHtml(x.cc)}, day ${x.day})</small> ${eur(x.price_eur)} €</li>`).join('');
        const flag = { RS: '🇷🇸' };
        const rsd = (n) => Math.round(n).toLocaleString();
        const r = roads.map(c => c.runs.map(x => `<li>${flag[c.country] || c.country} ${escapeHtml(x.from)} → ${escapeHtml(x.to)} <small class="muted">(day ${x.day}, ~${x.km} km)</small>
            ${rsd(x.rsd)} RSD <small class="muted">or ${eur(x.eur)} €</small></li>`).join('')
            + `<li class="muted"><small>Official price list${c.valid_from ? ' valid from ' + escapeHtml(c.valid_from) : ''} ·
              <a href="${escAttr(c.source)}" target="_blank" rel="noopener">Putevi Srbije ↗</a></small></li>`).join('');
        return `<div class="tb-tolls">
            ${v ? `<div class="tb-sub">🛣 Vignettes</div><ul>${v}</ul>` : ''}
            ${r ? `<div class="tb-sub">🚧 Motorway tolls (pay at the booth)</div><ul>${r}</ul>` : ''}
            ${t ? `<div class="tb-sub">Toll tunnels & bridges on the route</div><ul>${t}</ul>` : ''}
            <div class="tb-note">${escapeHtml(te.note || '')} <a href="${escAttr(te.attribution?.url || 'https://www.fuel-prices.eu/')}" target="_blank" rel="noopener">${escapeHtml(te.attribution?.text || 'Data: fuel-prices.eu, CC BY 4.0')}</a></div>
        </div>`;
    },

    collect(rp) {
        const b = rp.budget || {};
        const base = b.budget_currency || 'EUR';
        const roadKm = (rp.lastPlan?.legs || []).filter(l => l.mode === 'road').reduce((a, l) => a + l.distance_km, 0);
        const litres = roadKm * (b.fuel_l_per_100km || 0) / 100;
        // trip page: fuel per country (car consumption x price in each country), otherwise one average price
        const fe = rp.fuelEstimate, fp = rp.fuelPlan;
        const fuel = fp ? [{ amount: fp.cost_eur, cur: 'EUR' }] : fe ? fe.countries.filter(r => r.cost != null).map(r => ({ amount: r.cost, cur: r.currency }))
                        : (b.fuel_price ? [{ amount: litres * b.fuel_price, cur: b.fuel_currency || base }] : []);
        const last = rp.stops.length - 1;
        const tickets = rp.stops.filter((s, i) => i < last && s.legCost).map(s => ({ amount: s.legCost, cur: s.legCurrency }));
        const lodging = rp.stops.filter(s => s.stopType === 'overnight' && s.lodgingPrice).map(s => ({ amount: s.lodgingPrice, cur: s.lodgingCurrency }));
        const places = rp.stops.flatMap((s, i) => [...(s.spots || []), ...(i < last ? (s.legSpots || []) : [])])
            .filter(p => p.cost).map(p => ({ amount: p.cost, cur: p.currency || base }));
        const other = (b.extras || []).filter(e => e.amount).map(e => ({ amount: e.amount, cur: e.currency }));

        const bookings = [];
        rp.stops.forEach((s, i) => {
            const short = escapeHtml(String(s.name).split(',')[0]);
            if (s.stopType === 'overnight') {
                const dates = stayDates(rp.stops, i, document.getElementById('routeStartDate')?.value);
                const place = String(s.name).split(',').slice(0, 2).join(',');
                bookings.push({ kind: 'lodging', i, done: !!s.lodgingBooked, paid: !!s.lodgingPaid, price: s.lodgingPrice, cur: s.lodgingCurrency, dates,
                    find: { booking: bookingSearchUrl(place, dates), airbnb: airbnbSearchUrl(String(s.name).split(',')[0], dates) },
                    label: `🛏 ${s.lodgingName ? escapeHtml(s.lodgingName) + ' — ' : ''}${short}, ${s.nights || 1} night${(s.nights || 1) > 1 ? 's' : ''}`,
                    url: s.lodgingUrl });
            }
            if (i < last && (s.legMode === 'ferry' || s.legMode === 'flight')) {
                const to = escapeHtml(String(rp.stops[i + 1].name).split(',')[0]);
                bookings.push({ kind: 'leg', i, done: !!s.legBooked, paid: !!s.legPaid, price: s.legCost, cur: s.legCurrency,
                    find: s.legMode === 'ferry' ? { ferryhopper: 'https://www.ferryhopper.com/en/' } : { kiwi: 'https://www.kiwi.com/en/' },
                    label: `${s.legMode === 'ferry' ? '⛴' : '✈'} ${short} → ${to}${s.legDate ? ' · ' + escapeHtml(s.legDate) : ''}`,
                    url: s.legRef });
            }
        });
        // vignettes + toll tunnels/bridges: calculated on the trip page (needs the route by days)
        const te = rp.tollEstimate;
        const tolls = te && te.total_eur ? [{ amount: te.total_eur, cur: 'EUR' }] : [];
        return { b, base, roadKm, litres, fuel, fe, fp, tickets, lodging, places, other, bookings, te, tolls };
    },

    render(rp) {
        const el = this.el();
        if (!el || !rp) return;
        if (rp.stops.length < 2) { el.innerHTML = ''; return; }
        const c = this.collect(rp);
        const { b, base } = c;
        const needsRates = [c.fuel, c.tickets, c.lodging, c.places, c.other, c.tolls].flat().some(x => x.cur && x.cur !== base);
        if (needsRates) this.ensureRates(base, rp);

        const rows = [
            ['⛽ Fuel', c.fuel, c.fp
                ? `refuel plan: ${c.fp.stops.length} fill-ups, ${this.fmt(c.fp.saving_eur)} € cheaper than filling up when low${c.fp.missing.length ? ' — no price for ' + c.fp.missing.join(', ') : ''}`
                : c.fe
                ? `${this.fmt(c.fe.total_km)} km by road, prices by country${c.fe.countries.some(r => r.cost == null) ? ' — some countries have no price yet (tab Car & fuel)' : ''}`
                : (b.fuel_price ? `${this.fmt(c.roadKm)} km by road · ${this.fmt(c.litres)} L` : `${this.fmt(c.roadKm)} km by road — enter fuel price`)],
            ['⛴✈ Ferries & flights', c.tickets, 'ticket costs on ferry / flight legs'],
            ['🛏 Lodging', c.lodging, 'prices of overnight stays'],
            ['★ Places', c.places, 'costs entered on picked places'],
            ['🛣 Vignettes & tolls', c.tolls, c.te ? 'vignettes for the days you drive in each country + toll tunnels and bridges on the route (toll gates not included yet)'
                : 'calculated on the trip page'],
            ['➕ Other', c.other, 'insurance, food…'],
        ];
        const all = this.sum(rows.flatMap(r => r[1]), base);
        const sums = rows.map(r => this.sum(r[1], base));
        const done = c.bookings.filter(x => x.done).length;
        const paidN = c.bookings.filter(x => x.paid).length;
        const toPay = this.sum(c.bookings.filter(x => x.done && !x.paid && x.price).map(x => ({ amount: x.price, cur: x.cur })), base);
        const rateInfo = this.rates[base];
        const rateNote = !needsRates ? '' : rateInfo === 'loading' ? 'loading exchange rates…'
            : rateInfo === 'error' ? 'exchange rates unavailable — other currencies shown separately'
            : `rates: ${escapeHtml(rateInfo.source || '')}${rateInfo.updated ? ', ' + escapeHtml(String(rateInfo.updated).slice(0, 16)) : ''}${rateInfo.stale ? ' (old)' : ''}`;

        el.innerHTML = `
            <details class="tb" ${this.open ? 'open' : ''} ontoggle="TripBudget.open = this.open">
                <summary>💶 Budget ${this.amountHtml(all, base)}${c.bookings.length ? ` · booked ${done}/${c.bookings.length}` : ''}</summary>
                <div class="tb-settings">
                    <label>Totals in <select onchange="TripBudget.set('budget_currency', this.value)">${currencyOptions(base)}</select></label>
                    ${c.fe ? `<span class="tb-note">⛽ ${escapeHtml(rp.carLabel || 'car')} · fuel by country — see “Car & fuel”</span>` : `<label title="Fuel consumption">⛽ <input class="tb-num" inputmode="decimal" value="${b.fuel_l_per_100km ?? ''}" onchange="TripBudget.set('fuel_l_per_100km', this.value)"> L/100 km</label>
                    <label title="Fuel price per litre">× <input class="tb-num" inputmode="decimal" placeholder="price" value="${b.fuel_price ?? ''}" onchange="TripBudget.set('fuel_price', this.value)">
                        <select onchange="TripBudget.set('fuel_currency', this.value)">${currencyOptions(b.fuel_currency || base)}</select>/L</label>`}
                </div>
                <table class="tb-table">
                    ${rows.map((r, k) => `<tr title="${escAttr(r[2])}"><td>${r[0]}</td><td class="tb-amt">${r[1].length ? this.amountHtml(sums[k], base) : '<span class="muted">—</span>'}</td></tr>`).join('')}
                    <tr class="tb-total"><td>Total</td><td class="tb-amt">${this.amountHtml(all, base)}</td></tr>
                </table>
                ${this.tollsHtml(c.te)}
                ${rateNote ? `<div class="tb-note">${rateNote}</div>` : ''}
                <div class="tb-sub">➕ Other costs</div>
                ${(b.extras || []).map((e, k) => `
                    <div class="tb-extra">
                        <input class="on-input" placeholder="What" value="${escAttr(e.label || '')}" onchange="TripBudget.setExtra(${k}, 'label', this.value)">
                        <input class="on-input tb-num" inputmode="decimal" placeholder="0" value="${e.amount ?? ''}" onchange="TripBudget.setExtra(${k}, 'amount', this.value)">
                        <select onchange="TripBudget.setExtra(${k}, 'currency', this.value)">${currencyOptions(e.currency || base)}</select>
                        <button class="wp-btn wp-del" onclick="TripBudget.removeExtra(${k})" title="Remove"><i class="fas fa-times"></i></button>
                    </div>`).join('')}
                <button class="wp-link" onclick="TripBudget.addExtra()">+ add cost</button>
                ${c.bookings.length ? `
                    <div class="tb-sub">✅ Booked ${done}/${c.bookings.length} · 💳 paid ${paidN}${toPay.total || Object.keys(toPay.rest).length ? ` · <span class="ai-warn">still to pay ${this.amountHtml(toPay, base)}</span>` : ''}</div>
                    ${this.prefsHtml()}
                    ${c.bookings.map(x => `
                        <div class="tb-book ${x.done ? 'done' : ''} ${x.paid ? 'paid' : ''}">
                            <span class="tb-book-name">${x.label}${x.dates ? ` <small>${escapeHtml(x.dates.checkin.slice(5))} → ${escapeHtml(x.dates.checkout.slice(5))}</small>` : ''}</span>
                            <span class="tb-book-money">
                                <input class="tb-num tb-price" inputmode="decimal" placeholder="price" value="${x.price ?? ''}"
                                    onchange="TripBudget.setPrice('${x.kind}', ${x.i}, this.value)">
                                <select onchange="TripBudget.setCur('${x.kind}', ${x.i}, this.value)">${currencyOptions(x.cur || base)}</select>
                                <label class="${x.price ? '' : 'off'}" title="${x.price ? 'Booked' : 'Enter the price first — it goes into the budget'}">
                                    <input type="checkbox" ${x.done ? 'checked' : ''} ${x.price || x.done ? '' : 'disabled'} onchange="TripBudget.setBooked('${x.kind}', ${x.i}, this.checked)"> booked</label>
                                <label class="${x.done ? '' : 'off'}" title="${x.done ? 'Paid, not only reserved' : 'Tick “booked” first'}">
                                    <input type="checkbox" ${x.paid ? 'checked' : ''} ${x.done ? '' : 'disabled'} onchange="TripBudget.setPaid('${x.kind}', ${x.i}, this.checked)"> paid</label>
                            </span>
                            <span class="tb-find">
                                ${/^https?:\/\//i.test(x.url || '') ? `<a href="${escAttr(x.url)}" target="_blank" rel="noopener" title="Your booking">my booking ↗</a>` : ''}
                                ${!x.done && x.find ? Object.entries(x.find).map(([k, u]) => `<a class="find-${k}" href="${escAttr(u)}" target="_blank" rel="noopener"
                                    title="${k === 'booking' ? 'Booking.com with these dates, guests and minimal rating' : 'Open search'}">${{ booking: 'Booking.com', airbnb: 'Airbnb', ferryhopper: 'Ferryhopper', kiwi: 'Kiwi.com' }[k]} ↗</a>`).join('') : ''}
                            </span>
                        </div>`).join('')}
                    ${c.bookings.some(x => x.kind === 'lodging' && !x.dates) ? '<div class="tb-note">Set the trip start date to search with dates.</div>' : ''}
                    <div class="tb-note">Enter the price → tick “booked” → tick “paid” once the money is gone. Booking links and names: in the overnight stop on the map.</div>` : ''}
            </details>`;
    },

    prefsHtml() {
        const p = bookingPrefs();
        return `<div class="tb-prefs">🔎 Search with:
            <label>adults <input class="tb-num" type="number" min="1" max="16" value="${p.adults}" onchange="TripBudget.pref('adults', this.value)"></label>
            <label>children <input class="tb-num" type="number" min="0" max="10" value="${p.children}" onchange="TripBudget.pref('children', this.value)"></label>
            ${p.children ? `<label>ages <input class="tb-num ages" value="${escAttr(p.ages)}" placeholder="8, 5" onchange="TripBudget.pref('ages', this.value)"></label>` : ''}
            <label>rating ≥ <select onchange="TripBudget.pref('minScore', this.value)">${[0, 7, 8, 9].map(v => `<option value="${v}" ${v === p.minScore ? 'selected' : ''}>${v ? v + '+' : 'any'}</option>`).join('')}</select></label>
            <label>sort <select onchange="TripBudget.pref('sort', this.value)">
                ${[['review_score_and_price', 'rating & price'], ['price', 'price'], ['bayesian_review_score', 'rating']].map(([v, l]) => `<option value="${v}" ${v === p.sort ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
        </div>`;
    },

    pref(k, v) {
        setBookingPref(k, v);
        this.render(this.rp());
        window.dispatchEvent(new Event('bookingprefs'));  // other Booking.com links on the page follow
    },

    rp() { return window.routePlanner; },

    set(field, value) {
        const rp = this.rp();
        if (!rp) return;
        if (['fuel_l_per_100km', 'fuel_price'].includes(field)) {
            const n = parseFloat(String(value).replace(',', '.'));
            value = n > 0 ? n : null;
        }
        rp.budget = { ...rp.budget, [field]: value };
        rp.saveDraft();
        this.render(rp);
    },

    setExtra(k, field, value) {
        const rp = this.rp();
        const e = rp?.budget?.extras?.[k];
        if (!e) return;
        if (field === 'amount') {
            const n = parseFloat(String(value).replace(',', '.'));
            value = isNaN(n) ? 0 : Math.max(0, n);
        }
        e[field] = value;
        rp.saveDraft();
        this.render(rp);
    },

    addExtra() {
        const rp = this.rp();
        if (!rp) return;
        rp.budget.extras = [...(rp.budget.extras || []), { label: '', amount: 0, currency: rp.budget.budget_currency || 'EUR' }];
        this.open = true;
        this.render(rp);
        const inputs = this.el()?.querySelectorAll('.tb-extra input.on-input:not(.tb-num)');
        inputs?.[inputs.length - 1]?.focus();
    },

    removeExtra(k) {
        const rp = this.rp();
        if (!rp?.budget?.extras) return;
        rp.budget.extras = rp.budget.extras.filter((_, j) => j !== k);
        rp.saveDraft();
        this.render(rp);
    },

    setBooked(kind, i, checked) {
        const rp = this.rp();
        const s = rp?.stops[i];
        if (!s) return;
        if (kind === 'lodging') { s.lodgingBooked = checked; if (!checked) s.lodgingPaid = false; }
        else { s.legBooked = checked; if (!checked) s.legPaid = false; }
        rp.render();
    },

    setPaid(kind, i, checked) {
        const rp = this.rp();
        const s = rp?.stops[i];
        if (!s) return;
        if (kind === 'lodging') s.lodgingPaid = checked; else s.legPaid = checked;
        rp.render();
    },

    setPrice(kind, i, v) {
        const rp = this.rp();
        const s = rp?.stops[i];
        if (!s) return;
        const n = parseFloat(String(v).replace(',', '.'));
        const price = isNaN(n) || n <= 0 ? null : n;
        if (kind === 'lodging') { s.lodgingPrice = price; if (!s.lodgingCurrency) s.lodgingCurrency = rp.budget?.budget_currency || 'EUR'; }
        else { s.legCost = price; if (!s.legCurrency) s.legCurrency = rp.budget?.budget_currency || 'EUR'; }
        rp.render();
    },

    setCur(kind, i, v) {
        const rp = this.rp();
        const s = rp?.stops[i];
        if (!s) return;
        if (kind === 'lodging') s.lodgingCurrency = v; else s.legCurrency = v;
        rp.render();
    },
};

window.TripBudget = TripBudget;
