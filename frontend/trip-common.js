if (typeof window.escapeHtml !== 'function') {
    window.escapeHtml = function (text) {
        const d = document.createElement('div');
        d.textContent = text == null ? '' : String(text);
        return d.innerHTML;
    };
}

/**
 * TravelMate - shared trip logic for the map planner and the trip page:
 * stop fields, API mapping, day plan, payloads, small HTML helpers.
 */
const STOP_TYPES = {
    pass: { icon: '🔁', title: 'Pass through' },
    visit: { icon: '📍', title: 'Visit' },
    overnight: { icon: '🛏', title: 'Overnight' },
};
// every per-stop field: [name in the planner, name in the API, default]
const STOP_FIELDS = [
    ['stopType', 'stop_type', 'pass'], ['nights', 'nights', null],
    ['lodgingName', 'lodging_name', ''], ['lodgingUrl', 'lodging_url', ''], ['lodgingPrice', 'lodging_price', null],
    ['lodgingCurrency', 'lodging_currency', 'EUR'], ['lodgingBooked', 'lodging_booked', false], ['lodgingPaid', 'lodging_paid', false],
    // the leg from this stop to the next one: ticket cost & booking
    ['legCost', 'leg_cost', null], ['legCurrency', 'leg_currency', 'EUR'], ['legBooked', 'leg_booked', false], ['legPaid', 'leg_paid', false], ['legRef', 'leg_ref', ''],
    // places picked at this stop ("Popular here", own spots)
    ['spots', 'spots', null],
    // places on the way to the next stop (sights along the road - not stops themselves)
    ['legSpots', 'leg_spots', null],
];
const STOP_DEFAULTS = Object.fromEntries(STOP_FIELDS.map(([k, , d]) => [k, d]));
function stopFromApi(w) {
    const o = {};
    STOP_FIELDS.forEach(([k, a, d]) => { o[k] = (w[a] === undefined || w[a] === null || w[a] === '') ? d : w[a]; });
    return o;
}
const BUDGET_DEFAULTS = { fuel_l_per_100km: 7, fuel_price: null, fuel_currency: 'EUR', budget_currency: 'EUR', extras: [],
                          // refuel plan: start_pct = fuel already in the tank (not counted), 0 = only the reserve
                          fuel_settings: { v: 2, start_pct: 0, reserve_pct: 15, end: 'empty' } };
const CURRENCIES = ['EUR', 'RSD', 'USD', 'BGN', 'HUF', 'ALL', 'MKD', 'BAM', 'RON', 'CHF', 'GBP', 'TRY', 'RUB'];
function escAttr(v) {
    return String(v ?? '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function currencyOptions(selected) {
    const cur = selected || 'EUR';
    const list = CURRENCIES.includes(cur) ? CURRENCIES : [cur, ...CURRENCIES];
    return list.map(c => `<option ${c === cur ? 'selected' : ''}>${c}</option>`).join('');
}

// identity of a picked place: Wikidata id, user place id, or rounded coordinates
function spotKey(p) {
    return p.ref ? `${p.source === 'wiki' ? 'wd' : 'up'}:${p.ref}` : `${(+p.lat).toFixed(4)},${(+p.lng).toFixed(4)}`;
}

function pickStopFields(d) {
    const out = {};
    Object.keys(STOP_DEFAULTS).forEach(k => { if (d[k] !== undefined && d[k] !== null) out[k] = d[k]; });
    return out;
}

// API payload of the stops (same for the map planner and the trip page)
function stopsPayload(stops) {
    return stops.map((s, i) => ({
            name: s.name, latitude: s.lat, longitude: s.lng,
            leg_mode: i < stops.length - 1 ? (s.legMode || 'road') : 'road',
            leg_hours: s.legHours || null,
            leg_date: s.legDate || null,
            stop_type: s.stopType || 'pass',
            nights: s.stopType === 'overnight' ? (s.nights || 1) : null,
            lodging_name: s.stopType === 'overnight' ? (s.lodgingName || null) : null,
            lodging_url: s.stopType === 'overnight' ? (s.lodgingUrl || null) : null,
            lodging_price: s.stopType === 'overnight' && s.lodgingPrice ? s.lodgingPrice : null,
            lodging_currency: s.stopType === 'overnight' ? (s.lodgingCurrency || 'EUR') : null,
            lodging_booked: s.stopType === 'overnight' && s.lodgingBooked ? true : null,
            lodging_paid: s.stopType === 'overnight' && s.lodgingPaid ? true : null,
            leg_cost: i < stops.length - 1 && s.legCost ? s.legCost : null,
            leg_currency: i < stops.length - 1 && s.legCost ? (s.legCurrency || 'EUR') : null,
            leg_booked: i < stops.length - 1 && s.legBooked ? true : null,
            leg_paid: i < stops.length - 1 && s.legPaid ? true : null,
            leg_ref: i < stops.length - 1 ? (s.legRef || null) : null,
            spots: s.spots && s.spots.length ? s.spots : null,
            leg_spots: i < stops.length - 1 && s.legSpots && s.legSpots.length ? s.legSpots : null,
    }));
}

function budgetPayload(budget, carId) {
    const b = budget || BUDGET_DEFAULTS;
    return {
            fuel_l_per_100km: b.fuel_l_per_100km || null, fuel_price: b.fuel_price || null,
            fuel_currency: b.fuel_currency || 'EUR', budget_currency: b.budget_currency || 'EUR',
            extras: (b.extras || []).filter(e => e.label && e.amount >= 0),
        car_id: carId ?? null,
        fuel_settings: b.fuel_settings || null,
    };
}

// which day each stop falls on: an overnight stop with N nights moves the next stops N days later
function computeDayPlan(stops, start) {
        const fmt = (n) => {
            if (!start) return `Day ${n}`;
            const d = new Date(start + 'T12:00:00');
            d.setDate(d.getDate() + n - 1);
            return `Day ${n} · ${d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })}`;
        };
        const headerAt = {}, dayOf = [];
        let day = 1;
        stops.forEach((s, i) => {
            if (i === 0 || (stops[i - 1].stopType === 'overnight')) headerAt[i] = fmt(day);
            dayOf[i] = day;
            if (s.stopType === 'overnight') day += (s.nights || 1);
        });
        const hasOvernight = stops.some(s => s.stopType === 'overnight');
        return { headerAt: hasOvernight || start ? headerAt : {}, dayOf, totalDays: day, fmt };
}

/* ---------- booking links (no API: Booking.com's Demand API is for contracted affiliate partners only) ---------- */
const BOOKING_PREFS_KEY = 'travelmate_booking_prefs';
const BOOKING_DEFAULTS = { adults: 2, children: 0, ages: '', minScore: 8, sort: 'review_score_and_price' };

function bookingPrefs() {
    try { return { ...BOOKING_DEFAULTS, ...(JSON.parse(localStorage.getItem(BOOKING_PREFS_KEY) || '{}')) }; }
    catch (e) { return { ...BOOKING_DEFAULTS }; }
}

function setBookingPref(k, v) {
    const p = bookingPrefs();
    p[k] = ['adults', 'children', 'minScore'].includes(k) ? (parseInt(v, 10) || 0) : String(v || '');
    try { localStorage.setItem(BOOKING_PREFS_KEY, JSON.stringify(p)); } catch (e) { /* ignore */ }
    return p;
}

// check-in / check-out of an overnight stop from the trip start date
function stayDates(stops, i, start) {
    if (!start) return null;
    const plan = computeDayPlan(stops, start);
    const d = new Date(start + 'T12:00:00');
    d.setDate(d.getDate() + plan.dayOf[i] - 1);
    const out = new Date(d);
    out.setDate(out.getDate() + (stops[i].nights || 1));
    const iso = (x) => x.toISOString().slice(0, 10);
    return { checkin: iso(d), checkout: iso(out) };
}

// Booking.com search page with dates, guests, minimal review score and sorting pre-filled.
// The URL parameters are the ones booking.com's own search form uses; they are not a documented API and may change.
function bookingSearchUrl(place, dates, prefs = bookingPrefs()) {
    const q = new URLSearchParams({ ss: String(place || '').trim(), group_adults: prefs.adults || 2,
        no_rooms: 1, group_children: prefs.children || 0, order: prefs.sort || 'review_score_and_price', lang: 'en-gb' });
    if (dates) { q.set('checkin', dates.checkin); q.set('checkout', dates.checkout); }
    String(prefs.ages || '').split(/[\s,;]+/).filter(Boolean).slice(0, prefs.children || 0).forEach(a => q.append('age', a));
    if (prefs.minScore) q.set('nflt', `review_score=${prefs.minScore * 10}`);
    return `https://www.booking.com/searchresults.html?${q}`;
}

function airbnbSearchUrl(place, dates, prefs = bookingPrefs()) {
    const q = new URLSearchParams({ adults: prefs.adults || 2 });
    if (prefs.children) q.set('children', prefs.children);
    if (dates) { q.set('checkin', dates.checkin); q.set('checkout', dates.checkout); }
    return `https://www.airbnb.com/s/${encodeURIComponent(String(place || '').trim())}/homes?${q}`;
}

// "booked" needs a price (otherwise the budget misses it); "paid" needs "booked"
function bookedPaidHtml(i, kind, price, booked, paid) {
    const bk = kind === 'lodging' ? 'lodgingBooked' : 'legBooked', pd = kind === 'lodging' ? 'lodgingPaid' : 'legPaid';
    const can = !!price;
    return `<label class="booked-chk ${can ? '' : 'off'}" title="${can ? 'Booked' : 'Enter the price first — it goes into the budget'}">
            <input type="checkbox" ${booked ? 'checked' : ''} ${can || booked ? '' : 'disabled'} onchange="routePlanner.setStopField(${i}, '${bk}', this.checked)"> booked</label>
        <label class="booked-chk ${booked ? '' : 'off'}" title="${booked ? 'Paid (not only reserved)' : 'Tick “booked” first'}">
            <input type="checkbox" ${paid ? 'checked' : ''} ${booked ? '' : 'disabled'} onchange="routePlanner.setStopField(${i}, '${pd}', this.checked)"> paid</label>`;
}

/* ---------- language of place names (profile setting, this browser) ---------- */
const PLACE_LANGS = { ru: 'Русский', en: 'English', sr: 'Srpski', de: 'Deutsch', it: 'Italiano', el: 'Ελληνικά', local: 'Local (as on the map)' };
function placeLang() {
    try {
        const v = localStorage.getItem('travelmate_place_lang');
        if (v) return v;
    } catch (e) { /* ignore */ }
    const b = (navigator.language || 'en').slice(0, 2).toLowerCase();
    return PLACE_LANGS[b] ? b : 'en';
}
function setPlaceLang(v) {
    try { localStorage.setItem('travelmate_place_lang', v); } catch (e) { /* ignore */ }
}
function placeLangParam() { const l = placeLang(); return l === 'local' ? {} : { lang: l }; }

/* ---------- weather on the day of arrival (Open-Meteo, CC BY 4.0: attribution must be shown next to the data) ---------- */
// ISO date of the day we are at stop i (arrival); leaving=true: the day we leave it (after its nights)
function stopDate(stops, i, start, leaving = false) {
    if (!start || !stops[i]) return null;
    const plan = computeDayPlan(stops, start);
    const d = new Date(start + 'T12:00:00');
    d.setDate(d.getDate() + plan.dayOf[i] - 1 + (leaving && stops[i].stopType === 'overnight' ? (stops[i].nights || 1) : 0));
    return d.toISOString().slice(0, 10);
}

const Weather = {
    ATTR: '<a class="wx-attr" href="https://open-meteo.com/" target="_blank" rel="noopener">Weather data by Open-Meteo.com</a>',
    cache: new Map(),   // key -> Promise<day|null>
    key: (lat, lng, date) => `${(+lat).toFixed(2)}|${(+lng).toFixed(2)}|${date}`,

    // past days have no forecast and "usual weather" for them is not what the user wants to see
    usable(date) { return !!date && date >= new Date().toISOString().slice(0, 10); },

    get(lat, lng, date) {
        if (!this.usable(date)) return Promise.resolve(null);
        const k = this.key(lat, lng, date);
        if (!this.cache.has(k)) {
            this.cache.set(k, window.app.api.get('/locations/weather', { lat, lon: lng, date })
                .then(r => (r && (r.air || r.sea) ? r : null))
                .catch(() => { this.cache.delete(k); return null; }));
        }
        return this.cache.get(k);
    },

    // several points in one request (the Days tab); fills the cache
    async many(points) {
        const todo = points.filter(p => this.usable(p.date) && !this.cache.has(this.key(p.lat, p.lng, p.date)));
        for (let k = 0; k < todo.length; k += 40) {
            const part = todo.slice(k, k + 40);
            const req = window.app.api.post('/locations/weather', part.map(p => ({ lat: p.lat, lon: p.lng, date: p.date })))
                .then(r => r.days || []).catch(() => []);
            part.forEach((p, j) => this.cache.set(this.key(p.lat, p.lng, p.date),
                req.then(days => (days[j] && (days[j].air || days[j].sea) ? days[j] : null))));
        }
        return Promise.all(points.map(p => this.get(p.lat, p.lng, p.date)));
    },

    // "🌧 19°/12° · 80% rain · 🌊 22° · forecast"  or  "usually ☀️ 30°/20° · rain 1 day in 10 · 🌊 24°"
    html(w, { compact = false } = {}) {
        if (!w || (!w.air && !w.sea)) return '';
        const a = w.air, s = w.sea;
        const t = (x) => `${Math.round(x)}°`;
        const parts = [];
        if (a) {
            parts.push(`<span class="wx-sky" title="${escAttr(a.sky)}">${a.icon}</span> ${t(a.tmax)}/${t(a.tmin)}`);
            if (a.mode === 'forecast' && a.rain_prob != null && a.rain_prob >= 20) parts.push(`☔ ${a.rain_prob}%`);
            if (a.mode === 'climate' && a.rainy_share != null && a.rainy_share >= 0.1) parts.push(`☔ ${Math.round(a.rainy_share * 10)} day${Math.round(a.rainy_share * 10) > 1 ? 's' : ''} in 10`);
        }
        if (s) parts.push(`🌊 ${t(s.temp)}`);
        const climate = (a || s).mode === 'climate';
        const tip = climate ? `Usual weather for these dates (average of past years), ${a ? a.sky : ''}` : `Forecast${a ? ', ' + a.sky : ''}`;
        return `<span class="wx ${climate ? 'wx-usual' : 'wx-fc'}" title="${escAttr(tip)}">${climate ? (compact ? '~' : 'usually ') : ''}${parts.join(' · ')}${compact ? '' : (climate ? '' : ' · forecast')}</span>`;
    },

    // for the AI: short plain text
    text(w) {
        if (!w) return null;
        const a = w.air, s = w.sea;
        const out = {};
        if (a) Object.assign(out, { kind: a.mode === 'forecast' ? 'forecast' : 'usual for these dates', sky: a.sky,
            t_max: Math.round(a.tmax), t_min: Math.round(a.tmin),
            ...(a.rain_prob != null ? { rain_probability_pct: a.rain_prob } : {}),
            ...(a.rainy_share != null ? { rainy_days_share: a.rainy_share } : {}) });
        if (s) out.sea_temp = Math.round(s.temp);
        return out;
    },
};
window.Weather = Weather;
