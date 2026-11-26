/* "📋 From confirmation": paste a booking confirmation (text), drop a screenshot or a PDF -> the server reads it with
   Claude (/routes/booking-extract, nothing stored) -> the traveller checks the result and applies it to a lodging or a
   ferry/flight leg: price + currency, booked, paid (only when the confirmation says it is paid), name, link. */
const BookingImport = {
    file: null,
    target: null,          // {kind, i} preselected from a booking row
    res: null,

    open(kind, i) {
        const rp = window.routePlanner;
        if (!rp || rp.readOnly) return;
        this.file = null; this.res = null;
        this.target = kind ? { kind, i } : null;
        let el = document.getElementById('bkImport');
        if (!el) { el = document.createElement('div'); el.id = 'bkImport'; el.className = 'bk-modal'; document.body.appendChild(el); }
        el.hidden = false;
        el.innerHTML = `<div class="bk-box" role="dialog" aria-label="Booking from confirmation">
            <div class="bk-head"><b>📋 Booking from confirmation</b><button class="wp-btn" onclick="BookingImport.close()" title="Close">✕</button></div>
            <p class="tb-note">Paste the confirmation e-mail, or attach / paste a screenshot or PDF (Booking.com, Airbnb, hotel, ferry...).
               It is read by AI once and not stored; you check the result before it goes into the trip.</p>
            <textarea id="bkText" rows="7" placeholder="Paste the confirmation text here (Ctrl+V a screenshot works too)"></textarea>
            <div class="bk-row"><label class="btn btn-outline btn-sm">📎 Screenshot / PDF<input id="bkFile" type="file" accept="image/*,application/pdf" hidden></label>
                <span id="bkFileName" class="tb-note"></span></div>
            <div class="bk-row"><button id="bkRead" class="btn btn-primary btn-sm">Read confirmation</button><span id="bkStatus" class="tb-note"></span></div>
            <div id="bkResult"></div></div>`;
        el.onclick = (e) => { if (e.target === el) this.close(); };
        document.getElementById('bkFile').onchange = (e) => this.setFile(e.target.files[0]);
        document.getElementById('bkText').addEventListener('paste', (e) => {
            const it = [...(e.clipboardData?.items || [])].find(x => x.kind === 'file');
            if (it) { e.preventDefault(); this.setFile(it.getAsFile()); }
        });
        document.getElementById('bkRead').onclick = () => this.read();
        document.getElementById('bkText').focus();
    },

    close() { const el = document.getElementById('bkImport'); if (el) el.hidden = true; },

    setFile(f) {
        if (!f) return;
        if (!/^image\/|^application\/pdf$/.test(f.type)) { this.status('Use a screenshot or a PDF', true); return; }
        this.file = f;
        document.getElementById('bkFileName').textContent = `${f.name || 'pasted image'} (${Math.round(f.size / 1024)} KB)`;
    },

    status(t, err) { const s = document.getElementById('bkStatus'); if (s) { s.textContent = t; s.classList.toggle('err-text', !!err); } },

    // big screenshots -> JPEG max 2000 px (smaller upload, same readability)
    async fileB64(f) {
        let blob = f, type = f.type;
        if (type.startsWith('image/') && type !== 'image/gif') {
            const img = await createImageBitmap(f);
            const k = Math.min(1, 2000 / Math.max(img.width, img.height));
            if (k < 1 || f.size > 1.5e6) {
                const c = document.createElement('canvas');
                c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
                c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
                blob = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.88)); type = 'image/jpeg';
            }
        }
        if (blob.size > 5 * 1024 * 1024) throw new Error('File is larger than 5 MB');
        const buf = new Uint8Array(await blob.arrayBuffer());
        let s = ''; for (let k = 0; k < buf.length; k += 0x8000) s += String.fromCharCode.apply(null, buf.subarray(k, k + 0x8000));
        return { b64: btoa(s), type };
    },

    async read() {
        const text = document.getElementById('bkText').value.trim();
        if (!text && !this.file) { this.status('Paste the text or attach a file', true); return; }
        const btn = document.getElementById('bkRead');
        btn.disabled = true; this.status('Reading… (10–30 s)');
        try {
            const body = { text: text || null };
            if (this.file) { const f = await this.fileB64(this.file); body.file_b64 = f.b64; body.media_type = f.type; }
            const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 120000);
            const r = await fetch(`${window.CONFIG.API_BASE_URL}/routes/booking-extract`, {
                method: 'POST', signal: ctrl.signal,
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${localStorage.getItem('token')}` },
                body: JSON.stringify(body) });
            clearTimeout(t);
            const j = await r.json().catch(() => null);
            if (!r.ok) throw new Error((j && typeof j.detail === 'string' && j.detail) || `HTTP ${r.status}`);
            this.res = j; this.status('');
            this.showResult();
        } catch (e) {
            this.status(e.name === 'AbortError' ? 'Took too long, try again' : e.message, true);
        } finally { btn.disabled = false; }
    },

    // bookings of the trip the result can go to
    targets() {
        const rp = window.routePlanner, out = [], last = rp.stops.length - 1;
        const start = document.getElementById('routeStartDate')?.value;
        rp.stops.forEach((s, i) => {
            const short = String(s.name).split(',')[0];
            if (s.stopType === 'overnight') {
                const d = stayDates(rp.stops, i, start);
                out.push({ kind: 'lodging', i, label: `🛏 ${short}${d ? ` ${d.checkin.slice(5)} → ${d.checkout.slice(5)}` : ''}`, date: d?.checkin, city: short });
            }
            if (i < last && (s.legMode === 'ferry' || s.legMode === 'flight'))
                out.push({ kind: 'leg', i, label: `${s.legMode === 'ferry' ? '⛴' : '✈'} ${short} → ${String(rp.stops[i + 1].name).split(',')[0]}`,
                           date: s.legDate || stopDate(rp.stops, i, start, true), city: short });
        });
        return out;
    },

    guess(ts) {
        if (this.target) return ts.findIndex(t => t.kind === this.target.kind && t.i === this.target.i);
        const r = this.res, want = r.kind === 'lodging' ? 'lodging' : (r.kind === 'ferry' || r.kind === 'flight') ? 'leg' : null;
        const low = (x) => String(x || '').toLowerCase();
        let k = ts.findIndex(t => (!want || t.kind === want) && r.check_in && t.date === r.check_in);
        if (k < 0) k = ts.findIndex(t => (!want || t.kind === want) && r.city && (low(t.city).includes(low(r.city)) || low(r.city).includes(low(t.city))));
        return k;
    },

    showResult() {
        const r = this.res, el = document.getElementById('bkResult');
        if (!r.is_booking) { el.innerHTML = '<p class="err-text">This does not look like a booking confirmation.</p>'; return; }
        const ts = this.targets();
        if (!ts.length) { el.innerHTML = '<p class="err-text">The trip has no overnight stops or ferry/flight legs to attach this to.</p>'; return; }
        const k = this.guess(ts);
        const pay = { paid: '✅ paid in full', partly_paid: '◐ deposit paid' + (r.amount_paid ? ` (${r.amount_paid} ${escapeHtml(r.currency || '')})` : ''),
                      pay_later: '⏳ pay later' + (r.pay_due ? ` (${escapeHtml(r.pay_due)})` : ''), unknown: '? payment not stated' }[r.payment || 'unknown'];
        const line = (a, b) => b ? `<tr><td>${a}</td><td>${b}</td></tr>` : '';
        el.innerHTML = `<table class="bk-table">
                ${line('What', escapeHtml(r.name || '—') + (r.booking_site ? ` <small class="muted">${escapeHtml(r.booking_site)}</small>` : ''))}
                ${line('Where', escapeHtml([r.address || r.city, r.to_city ? '→ ' + r.to_city : ''].filter(Boolean).join(' ')))}
                ${line('Dates', escapeHtml([r.check_in, r.check_out].filter(Boolean).join(' → ')))}
                ${line('Price', r.total_price != null ? `<b>${r.total_price} ${escapeHtml(r.currency || '')}</b>` : '<span class="err-text">not found</span>')}
                ${line('Payment', pay)}
                ${line('Free cancellation', escapeHtml(r.free_cancellation_until || ''))}
                ${line('Confirmation №', escapeHtml(r.confirmation_number || ''))}
                ${line('Note', escapeHtml(r.notes || ''))}
            </table>
            <label class="bk-row">Put into <select id="bkTarget">${k < 0 ? '<option value="">— choose —</option>' : ''}${ts.map((t, j) => `<option value="${j}" ${j === k ? 'selected' : ''}>${escapeHtml(t.label)}</option>`).join('')}</select></label>
            <div id="bkWarn" class="tb-note"></div>
            <div class="bk-row bk-checks">
                <label><input type="checkbox" id="bkPrice" ${r.total_price != null ? 'checked' : 'disabled'}> price</label>
                <label><input type="checkbox" id="bkBooked" ${r.total_price != null ? 'checked' : 'disabled'}> booked</label>
                <label title="Only when the confirmation says the full amount was paid"><input type="checkbox" id="bkPaid" ${r.payment === 'paid' && r.total_price != null ? 'checked' : ''} ${r.total_price != null ? '' : 'disabled'}> paid</label>
                <label><input type="checkbox" id="bkName" ${r.name ? 'checked' : 'disabled'}> name</label>
                <label><input type="checkbox" id="bkUrl" ${/^https?:\/\//i.test(r.url || '') ? 'checked' : 'disabled'}> link</label>
            </div>
            <div class="bk-row"><button id="bkApply" class="btn btn-primary btn-sm">Apply to the trip</button></div>`;
        const sel = document.getElementById('bkTarget');
        const warn = () => {
            const t = ts[sel.value];
            const w = [];
            if (t && r.check_in && t.date && t.date !== r.check_in) w.push(`dates differ: the trip has ${t.date}, the confirmation ${r.check_in}`);
            if (r.payment === 'partly_paid') w.push('only a deposit is paid — “paid” is left unticked');
            document.getElementById('bkWarn').innerHTML = w.map(x => `⚠ ${escapeHtml(x)}`).join('<br>');
        };
        sel.onchange = warn; warn();
        document.getElementById('bkApply').onclick = () => this.apply(ts[sel.value]);
    },

    apply(t) {
        if (!t) { document.getElementById('bkWarn').textContent = 'Choose where to put it'; return; }
        const rp = window.routePlanner, s = rp.stops[t.i], r = this.res, on = (id) => document.getElementById(id).checked;
        const L = t.kind === 'lodging';
        if (on('bkPrice')) {
            s[L ? 'lodgingPrice' : 'legCost'] = r.total_price;
            if (r.currency) s[L ? 'lodgingCurrency' : 'legCurrency'] = r.currency;
        }
        if (on('bkBooked')) s[L ? 'lodgingBooked' : 'legBooked'] = true;
        if (on('bkPaid')) { s[L ? 'lodgingBooked' : 'legBooked'] = true; s[L ? 'lodgingPaid' : 'legPaid'] = true; }
        if (L && on('bkName')) s.lodgingName = r.name;
        if (on('bkUrl')) s[L ? 'lodgingUrl' : 'legRef'] = r.url;
        else if (!L && r.confirmation_number && !s.legRef) s.legRef = r.confirmation_number;
        if (!L && r.check_in && !s.legDate) s.legDate = r.check_in;
        rp.render();
        this.close();
        window.app?.showStatus?.('Booking added to the trip', 'success');
    },
};
window.BookingImport = BookingImport;
