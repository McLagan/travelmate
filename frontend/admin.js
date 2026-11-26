/* Admin area: overview, vignettes & toll crossings (review imported changes, override, hide, add),
   motorway tolls (official price lists by country + Italian operator rates), action log.
   Every request is checked on the server (users.is_admin). */
(function () {
    const $ = (id) => document.getElementById(id);
    const esc = (t) => String(t ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const dt = (s) => s ? new Date(s + (/[zZ+]/.test(s.slice(-6)) ? '' : 'Z')).toLocaleString() : '—';
    const eur = (n) => n == null ? '—' : (Math.round(n * 100) / 100).toLocaleString(undefined, { maximumFractionDigits: 2 });
    const FLAG = { RS: '🇷🇸', HR: '🇭🇷', IT: '🇮🇹', FR: '🇫🇷', BA: '🇧🇦', NO: '🇳🇴', GR: '🇬🇷', MK: '🇲🇰', AL: '🇦🇱', ME: '🇲🇪' };
    const NAME = { RS: 'Serbia', HR: 'Croatia', IT: 'Italy (estimate)', FR: 'France (estimate)', BA: 'Bosnia & Herzegovina (A1)',
                   NO: 'Norway', GR: 'Greece', MK: 'North Macedonia', AL: 'Albania', ME: 'Montenegro' };

    async function api(method, path, body) {
        const r = await fetch(path, {
            method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${localStorage.getItem('token')}` },
            body: body ? JSON.stringify(body) : undefined,
        });
        const j = r.status === 204 ? null : await r.json().catch(() => null);
        if (!r.ok) { const e = new Error(j && typeof j.detail === 'string' ? j.detail : `HTTP ${r.status}`); e.status = r.status; throw e; }
        return j;
    }

    let st = null, lists = [], items = [], rates = [];

    /* ---------- data ---------- */
    async function refreshStatus() {
        [st, lists] = await Promise.all([api('GET', '/admin/api/tolls/status'), api('GET', '/admin/api/tolls/lists')]);
        const listProblems = lists.filter(l => (l.last_error && !/^In progress/.test(l.last_error)) || (!l.active && !l.last_error)).length;
        $('nbItems').textContent = st.to_review || '';
        $('nbTolls').textContent = (st.rates_to_review + listProblems) || '';
    }

    function itemsQuery() {
        const q = new URLSearchParams({ group: 'items' });
        if ($('fCountry').value) q.set('country', $('fCountry').value);
        if ($('fType').value) q.set('type', $('fType').value);
        if ($('fOnly').value) q.set('only', $('fOnly').value);
        if ($('fQ').value.trim()) q.set('q', $('fQ').value.trim());
        return q;
    }
    function ratesQuery() {
        const q = new URLSearchParams({ group: 'rates', country: $('rCountry').value });
        if ($('rOnly').value) q.set('only', $('rOnly').value);
        return q;
    }

    /* ---------- overview ---------- */
    function listCard(l, withButton) {
        const a = l.active, busy = /^In progress/.test(l.last_error || '');
        const bad = (!!l.last_error && !busy) || (!a && !busy), warn = busy || (a && a.missing_coords.length);
        return `<div class="adm-card ${bad ? 'is-bad' : warn ? 'is-warn' : 'is-ok'}">
            <div class="adm-card-head">${FLAG[l.country] || ''} <b>${esc(NAME[l.country] || l.country)}</b>
                <span class="adm-pill">${bad ? 'needs a look' : busy ? 'downloading' : warn ? 'check' : 'ok'}</span></div>
            <div>${a ? `${esc(a.valid_from || '')}<br><small>${esc(a.summary)}</small>` : '<span class="err-text">no data yet</span>'}</div>
            <div class="tb-note">checked ${dt(l.last_ok_at)} · <a href="${esc(l.page || l.source)}" target="_blank" rel="noopener">source ↗</a></div>
            ${a && a.missing_coords.length ? `<div class="tb-note err-text">${esc(a.attention_label)}: ${esc(a.missing_coords.join(', '))}</div>` : ''}
            ${l.last_error ? `<div class="tb-note ${busy ? '' : 'err-text'}">${busy ? '' : 'last check failed '}(${dt(l.last_attempt_at)}): ${esc(l.last_error)}</div>` : ''}
            ${withButton ? `<button class="btn btn-outline btn-sm" data-check="${esc(l.country)}">Check now</button>` : ''}
        </div>`;
    }

    function renderOverview() {
        const s = st;
        $('ovCards').innerHTML = `
            <a class="adm-card ${s.last_error ? 'is-bad' : s.to_review ? 'is-warn' : 'is-ok'}" href="#vignettes">
                <div class="adm-card-head">🛣 <b>Vignettes &amp; crossings</b><span class="adm-pill">${s.to_review ? s.to_review + ' to review' : 'ok'}</span></div>
                <div>${s.total} records from fuel-prices.eu</div>
                <div class="tb-note">last import ${dt(s.last_ok_at)}</div>
                ${s.last_error ? `<div class="tb-note err-text">last attempt failed: ${esc(s.last_error)}</div>` : ''}
            </a>
            ${lists.map(l => `<div class="adm-card-link" data-go="tolls">${listCard(l, false)}</div>`).join('')}
            <a class="adm-card ${s.rates_to_review ? 'is-warn' : 'is-ok'}" href="#tolls">
                <div class="adm-card-head">🇮🇹🇫🇷 <b>Per-km operator rates</b><span class="adm-pill">${s.rates_to_review ? s.rates_to_review + ' to review' : 'ok'}</span></div>
                <div class="tb-note">Operators priced with the default rate are estimates.</div>
            </a>`;
        $('ovCards').querySelectorAll('[data-go]').forEach(c => c.onclick = (e) => { if (!e.target.closest('a')) location.hash = c.dataset.go; });
    }

    /* ---------- vignettes & crossings ---------- */
    async function loadItems() {
        items = await api('GET', `/admin/api/tolls?${itemsQuery()}`);
        $('tollTable').innerHTML = table(items, false);
        const n = items.filter(r => !r.reviewed).length;
        $('btnReviewShown').textContent = `✓ Mark shown as reviewed${n ? ` (${n})` : ''}`;
        $('btnReviewShown').disabled = !n;
    }

    function renderItemsStatus() {
        const s = st;
        $('tollStatus').innerHTML = `Source: <a href="${esc(s.source)}" target="_blank" rel="noopener">fuel-prices.eu</a> (${esc(s.attribution.text)}) ·
            last import: <b>${dt(s.last_ok_at)}</b>${s.last_error ? ` · <span class="err-text">last attempt failed: ${esc(s.last_error)}</span>` : ''} ·
            ${s.total} records · <b>${s.to_review}</b> to review`;
        const sel = $('fCountry');
        if (sel.options.length < 2) {
            api('GET', '/admin/api/tolls?group=items').then(all => {
                const codes = [...new Set(all.map(r => r.country))].sort();
                sel.innerHTML += codes.map(c => `<option value="${c}">${c} ${esc(s.countries[c] || '')}</option>`).join('');
            });
        }
    }

    function table(list, isRates) {
        if (!list.length) return '<p class="tb-note">Nothing here.</p>';
        return `<table class="admin-table">
            <tr>${isRates ? '<th>Operator</th><th>Kind</th><th>Source rate</th>' : '<th>CC</th><th>Type</th><th>Name / info</th><th>Days</th><th>Source €</th>'}<th>Our €</th><th></th></tr>
            ${list.map(r => {
                const isKm = r.type === 'rate_km';
                const val = (v) => isKm ? `${v} €/km` : `${eur(v)} €`;
                return `<tr class="${r.hidden ? 'is-hidden' : ''} ${r.reviewed ? '' : 'to-review'}">
                ${isRates
                    ? `<td><b>${esc(r.name)}</b><div class="tb-note">${esc(r.info || '')}</div></td><td>${isKm ? 'per km' : 'flat'}</td>`
                    : `<td>${esc(r.country)}</td><td>${esc(r.type)}</td>
                       <td><b>${esc(r.name)}</b>${r.source === 'admin' ? ' <span class="sec-badge ok">added by hand</span>' : ''}${r.gone ? ' <span class="sec-badge warn">no longer in source</span>' : ''}
                           <div class="tb-note">${esc(r.info || '')}${r.url ? ` · <a href="${esc(r.url)}" target="_blank" rel="noopener">official ↗</a>` : ''}</div></td>
                       <td>${r.type === 'vignette' ? (r.days ?? '<span class="err-text">?</span>') : ''}</td>`}
                <td>${val(r.price_eur)}${r.prev_price_eur != null && r.prev_price_eur !== r.price_eur ? `<div class="tb-note">was ${val(r.prev_price_eur)}</div>` : ''}</td>
                <td><input class="admin-price" data-id="${r.id}" value="${r.override_price_eur ?? ''}" placeholder="—" inputmode="decimal"></td>
                <td class="admin-act">
                    ${r.reviewed ? '' : `<button class="btn btn-primary btn-sm" data-act="ok" data-id="${r.id}">OK</button>`}
                    <button class="btn btn-outline btn-sm" data-act="hide" data-id="${r.id}">${r.hidden ? 'Show' : 'Hide'}</button>
                    ${r.source === 'admin' ? `<button class="btn btn-outline btn-sm" data-act="del" data-id="${r.id}">Delete</button>` : ''}
                </td></tr>`;
            }).join('')}
        </table>`;
    }

    /* ---------- motorway tolls ---------- */
    function renderLists() {
        $('listCards').innerHTML = lists.map(l => listCard(l, true)).join('');
        $('listCards').querySelectorAll('[data-check]').forEach(b => b.onclick = async () => {
            b.disabled = true; b.textContent = 'Checking… (Italy: up to a few minutes)';
            try {
                const r = await api('POST', `/admin/api/tolls/lists/${b.dataset.check}/check`);
                if (!r.ok) alert(`Failed: ${r.error}`);
            } catch (err) { alert(err.message); }
            await refreshStatus(); renderLists(); await loadRates();
        });
    }

    async function loadRates() {
        rates = await api('GET', `/admin/api/tolls?${ratesQuery()}`);
        $('rateTable').innerHTML = rates.length ? table(rates, true)
            : '<p class="tb-note">No operators yet — they appear after the first successful check of this country above.</p>';
        const n = rates.filter(r => !r.reviewed).length;
        $('btnRatesReviewed').textContent = `✓ Mark shown as reviewed${n ? ` (${n})` : ''}`;
        $('btnRatesReviewed').disabled = !n;
    }

    /* ---------- shared row actions ---------- */
    const findRow = (id) => items.find(x => x.id === id) || rates.find(x => x.id === id);
    async function reloadCurrent() { await refreshStatus(); await show(current, true); }

    async function act(e) {
        const b = e.target.closest('button[data-act]');
        if (!b) return;
        const id = +b.dataset.id, r = findRow(id);
        try {
            if (b.dataset.act === 'ok') await api('PATCH', `/admin/api/tolls/${id}`, { reviewed: true });
            if (b.dataset.act === 'hide') await api('PATCH', `/admin/api/tolls/${id}`, { hidden: !r.hidden, reviewed: true });
            if (b.dataset.act === 'del' && confirm(`Delete "${r.name}"?`)) await api('DELETE', `/admin/api/tolls/${id}`);
            await reloadCurrent();
        } catch (err) { alert(err.message); }
    }

    async function price(e) {
        const inp = e.target.closest('.admin-price');
        if (!inp) return;
        const v = inp.value.trim().replace(',', '.');
        try {
            await api('PATCH', `/admin/api/tolls/${inp.dataset.id}`, v === '' ? { clear_override: true, reviewed: true } : { override_price_eur: parseFloat(v), reviewed: true });
            await reloadCurrent();
        } catch (err) { alert(err.message); }
    }

    async function reviewShown(query, list) {
        const n = list.filter(r => !r.reviewed).length;
        if (!n || !confirm(`Mark ${n} shown record${n > 1 ? 's' : ''} as reviewed?`)) return;
        try { await api('POST', `/admin/api/tolls/review-shown?${query}`); await reloadCurrent(); }
        catch (err) { alert(err.message); }
    }

    async function add(e) {
        e.preventDefault();
        const f = e.target, num = (x) => x.value.trim() === '' ? null : parseFloat(x.value.replace(',', '.'));
        try {
            await api('POST', '/admin/api/tolls', { country: f.country.value.trim(), type: f.type.value, name: f.name.value.trim(),
                price_eur: num(f.price_eur), lat: num(f.lat), lng: num(f.lng), info: f.info.value.trim() || null });
            f.reset(); f.hidden = true;
            await reloadCurrent();
        } catch (err) { alert(err.message); }
    }

    async function loadLog() {
        const list = await api('GET', '/admin/api/log');
        $('logTable').innerHTML = `<table class="admin-table"><tr><th>When</th><th>Who</th><th>Action</th><th>Details</th></tr>
            ${list.map(l => `<tr><td>${dt(l.at)}</td><td>${esc(l.user)}</td><td>${esc(l.action)}</td><td class="tb-note">${esc(l.details)}</td></tr>`).join('')}</table>`;
    }

    /* ---------- navigation ---------- */
    const SECTIONS = ['overview', 'vignettes', 'tolls', 'log'];
    let current = 'overview';
    async function show(sec, keepScroll) {
        current = SECTIONS.includes(sec) ? sec : 'overview';
        document.querySelectorAll('.adm-nav a').forEach(a => a.classList.toggle('active', a.dataset.sec === current));
        document.querySelectorAll('.adm-sec').forEach(p => { p.hidden = p.id !== `sec-${current}`; });
        if (!keepScroll) window.scrollTo(0, 0);
        try {
            if (current === 'overview') renderOverview();
            if (current === 'vignettes') { renderItemsStatus(); await loadItems(); }
            if (current === 'tolls') { renderLists(); await loadRates(); }
            if (current === 'log') await loadLog();
        } catch (err) { alert(err.message); }
    }

    document.addEventListener('DOMContentLoaded', async () => {
        try { await api('GET', '/admin/api/me'); }
        catch (e) { $('adminDenied').hidden = false; if (e.status === 401) location.href = '/map'; return; }
        ['fCountry', 'fType', 'fOnly'].forEach(id => $(id).addEventListener('change', loadItems));
        let t; $('fQ').addEventListener('input', () => { clearTimeout(t); t = setTimeout(loadItems, 400); });
        $('rOnly').addEventListener('change', loadRates);
        $('rCountry').addEventListener('change', loadRates);
        $('btnImport').addEventListener('click', async (e) => {
            e.target.disabled = true;
            try { const r = await api('POST', '/admin/api/tolls/import'); alert(r.ok ? `Imported ${r.count}: ${r.new} new, ${r.changed} changed, ${r.gone} gone` : `Failed: ${r.error}`); }
            catch (err) { alert(err.message); }
            e.target.disabled = false;
            await reloadCurrent();
        });
        $('btnReviewShown').addEventListener('click', () => reviewShown(itemsQuery(), items));
        $('btnRatesReviewed').addEventListener('click', () => reviewShown(ratesQuery(), rates));
        $('btnAdd').addEventListener('click', () => { $('addForm').hidden = !$('addForm').hidden; });
        $('addForm').addEventListener('submit', add);
        ['tollTable', 'rateTable'].forEach(id => { $(id).addEventListener('click', act); $(id).addEventListener('change', price); });
        window.addEventListener('hashchange', () => show(location.hash.slice(1)));
        $('fOnly').value = 'review';
        await refreshStatus();
        await show(location.hash.slice(1) || 'overview');
    });
})();
