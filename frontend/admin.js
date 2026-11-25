/* Admin area: vignettes & tolls (review imported changes, override, hide, add), action log.
   Every request is checked on the server (users.is_admin). */
(function () {
    const $ = (id) => document.getElementById(id);
    const esc = (t) => String(t ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const dt = (s) => s ? new Date(s + (/[zZ+]/.test(s.slice(-6)) ? '' : 'Z')).toLocaleString() : '—';
    const eur = (n) => n == null ? '—' : (Math.round(n * 100) / 100).toLocaleString(undefined, { maximumFractionDigits: 2 });

    async function api(method, path, body) {
        const r = await fetch(path, {
            method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${localStorage.getItem('token')}` },
            body: body ? JSON.stringify(body) : undefined,
        });
        const j = r.status === 204 ? null : await r.json().catch(() => null);
        if (!r.ok) { const e = new Error(j && typeof j.detail === 'string' ? j.detail : `HTTP ${r.status}`); e.status = r.status; throw e; }
        return j;
    }

    let rows = [];

    const FLAG = { RS: '🇷🇸', HR: '🇭🇷', IT: '🇮🇹' };
    async function listsStatus() {
        const lists = await api('GET', '/admin/api/tolls/lists');
        $('rsStatus').innerHTML = lists.map(s => {
            const a = s.active;
            return `<div>${FLAG[s.country] || s.country} <b>${esc(s.country)} motorway tolls</b>: <a href="${esc(s.page || s.source)}" target="_blank" rel="noopener">official source</a> ·
                ${a ? `${esc(a.valid_from || '')} · ${esc(a.summary)}` : '<span class="err-text">no data yet</span>'}
                · checked ${dt(s.last_ok_at)}
                ${a && a.missing_coords.length ? ` · <span class="err-text">${esc(a.attention_label)}: ${esc(a.missing_coords.join(', '))}</span>` : ''}
                ${s.last_error ? ` · <span class="err-text">last check failed: ${esc(s.last_error)}</span>` : ''}
                <button class="btn btn-outline btn-sm" data-check="${esc(s.country)}">Check now</button></div>`;
        }).join('');
        $('rsStatus').querySelectorAll('[data-check]').forEach(b => b.onclick = async (e) => {
            e.target.disabled = true;
            try { const r = await api('POST', `/admin/api/tolls/lists/${b.dataset.check}/check`); alert(r.ok ? `OK${r.changed === false ? ' (unchanged)' : ' (activated)'}` : `Failed: ${r.error}`); }
            catch (err) { alert(err.message); }
            await listsStatus();
        });
    }

    async function status() {
        const s = await api('GET', '/admin/api/tolls/status');
        $('tollStatus').innerHTML = `Source: <a href="${esc(s.source)}" target="_blank" rel="noopener">fuel-prices.eu</a> (${esc(s.attribution.text)}) ·
            last import: <b>${dt(s.last_ok_at)}</b>${s.last_error ? ` · <span class="err-text">last attempt failed: ${esc(s.last_error)}</span>` : ''} ·
            ${s.total} records · <b>${s.to_review}</b> to review`;
        const sel = $('fCountry');
        if (sel.options.length < 2) {
            const codes = [...new Set((await api('GET', '/admin/api/tolls')).map(r => r.country))].sort();
            sel.innerHTML += codes.map(c => `<option value="${c}">${c} ${esc(s.countries[c] || '')}</option>`).join('');
        }
    }

    function filterQuery() {
        const q = new URLSearchParams();
        if ($('fCountry').value) q.set('country', $('fCountry').value);
        if ($('fType').value) q.set('type', $('fType').value);
        if ($('fOnly').value) q.set('only', $('fOnly').value);
        if ($('fQ').value.trim()) q.set('q', $('fQ').value.trim());
        return q;
    }

    async function load() {
        rows = await api('GET', `/admin/api/tolls?${filterQuery()}`);
        render();
        const n = rows.filter(r => !r.reviewed).length;
        $('btnReviewShown').textContent = `✓ Mark shown as reviewed${n ? ` (${n})` : ''}`;
        $('btnReviewShown').disabled = !n;
    }

    async function reviewShown() {
        const n = rows.filter(r => !r.reviewed).length;
        if (!n || !confirm(`Mark ${n} shown record${n > 1 ? 's' : ''} as reviewed?`)) return;
        try { await api('POST', `/admin/api/tolls/review-shown?${filterQuery()}`); await load(); await status(); }
        catch (err) { alert(err.message); }
    }

    function render() {
        $('tollTable').innerHTML = `<table class="admin-table">
            <tr><th>CC</th><th>Type</th><th>Name / info</th><th>Days</th><th>Source €</th><th>Our €</th><th></th></tr>
            ${rows.map(r => `<tr class="${r.hidden ? 'is-hidden' : ''} ${r.reviewed ? '' : 'to-review'}">
                <td>${esc(r.country)}</td><td>${esc(r.type)}</td>
                <td><b>${esc(r.name)}</b>${r.source === 'admin' ? ' <span class="sec-badge ok">added by hand</span>' : ''}${r.gone ? ' <span class="sec-badge warn">no longer in source</span>' : ''}
                    <div class="tb-note">${esc(r.info || '')}${r.url ? ` · <a href="${esc(r.url)}" target="_blank" rel="noopener">official ↗</a>` : ''}</div></td>
                <td>${r.type === 'vignette' ? (r.days ?? '<span class="err-text">?</span>') : ''}</td>
                <td>${r.type === 'rate_km' ? `${r.price_eur} €/km` : eur(r.price_eur)}${r.prev_price_eur != null && r.prev_price_eur !== r.price_eur ? `<div class="tb-note">was ${r.type === 'rate_km' ? r.prev_price_eur : eur(r.prev_price_eur)}</div>` : ''}</td>
                <td><input class="admin-price" data-id="${r.id}" value="${r.override_price_eur ?? ''}" placeholder="—" inputmode="decimal"></td>
                <td class="admin-act">
                    ${r.reviewed ? '' : `<button class="btn btn-primary btn-sm" data-act="ok" data-id="${r.id}">OK</button>`}
                    <button class="btn btn-outline btn-sm" data-act="hide" data-id="${r.id}">${r.hidden ? 'Show' : 'Hide'}</button>
                    ${r.source === 'admin' ? `<button class="btn btn-outline btn-sm" data-act="del" data-id="${r.id}">Delete</button>` : ''}
                </td></tr>`).join('')}
        </table>${rows.length ? '' : '<p class="tb-note">Nothing here.</p>'}`;
    }

    async function act(e) {
        const b = e.target.closest('button[data-act]');
        if (!b) return;
        const id = +b.dataset.id, r = rows.find(x => x.id === id);
        try {
            if (b.dataset.act === 'ok') await api('PATCH', `/admin/api/tolls/${id}`, { reviewed: true });
            if (b.dataset.act === 'hide') await api('PATCH', `/admin/api/tolls/${id}`, { hidden: !r.hidden, reviewed: true });
            if (b.dataset.act === 'del' && confirm(`Delete "${r.name}"?`)) await api('DELETE', `/admin/api/tolls/${id}`);
            await load(); await status();
        } catch (err) { alert(err.message); }
    }

    async function price(e) {
        const inp = e.target.closest('.admin-price');
        if (!inp) return;
        const v = inp.value.trim().replace(',', '.');
        try {
            await api('PATCH', `/admin/api/tolls/${inp.dataset.id}`, v === '' ? { clear_override: true, reviewed: true } : { override_price_eur: parseFloat(v), reviewed: true });
            await load(); await status();
        } catch (err) { alert(err.message); }
    }

    async function add(e) {
        e.preventDefault();
        const f = e.target, num = (x) => x.value.trim() === '' ? null : parseFloat(x.value.replace(',', '.'));
        try {
            await api('POST', '/admin/api/tolls', { country: f.country.value.trim(), type: f.type.value, name: f.name.value.trim(),
                price_eur: num(f.price_eur), lat: num(f.lat), lng: num(f.lng), info: f.info.value.trim() || null });
            f.reset(); f.hidden = true;
            await load(); await status();
        } catch (err) { alert(err.message); }
    }

    async function loadLog() {
        const list = await api('GET', '/admin/api/log');
        $('logTable').innerHTML = `<table class="admin-table"><tr><th>When</th><th>Who</th><th>Action</th><th>Details</th></tr>
            ${list.map(l => `<tr><td>${dt(l.at)}</td><td>${esc(l.user)}</td><td>${esc(l.action)}</td><td class="tb-note">${esc(l.details)}</td></tr>`).join('')}</table>`;
    }

    function showTab(t) {
        document.querySelectorAll('.admin-tab').forEach(b => b.classList.toggle('active', b.dataset.tab === t));
        document.querySelectorAll('.admin-panel').forEach(p => { p.hidden = p.id !== `tab-${t}`; });
        if (t === 'log') loadLog();
    }

    document.addEventListener('DOMContentLoaded', async () => {
        try { await api('GET', '/admin/api/me'); }
        catch (e) { $('adminDenied').hidden = false; if (e.status === 401) location.href = '/map'; return; }
        document.querySelectorAll('.admin-tab').forEach(b => b.addEventListener('click', () => showTab(b.dataset.tab)));
        ['fCountry', 'fType', 'fOnly'].forEach(id => $(id).addEventListener('change', load));
        let t; $('fQ').addEventListener('input', () => { clearTimeout(t); t = setTimeout(load, 400); });
        $('btnImport').addEventListener('click', async (e) => {
            e.target.disabled = true;
            try { const r = await api('POST', '/admin/api/tolls/import'); alert(r.ok ? `Imported ${r.count}: ${r.new} new, ${r.changed} changed, ${r.gone} gone` : `Failed: ${r.error}`); }
            catch (err) { alert(err.message); }
            e.target.disabled = false;
            await status(); await load();
        });
        $('btnReviewShown').addEventListener('click', reviewShown);
        $('btnAdd').addEventListener('click', () => { $('addForm').hidden = !$('addForm').hidden; });
        $('addForm').addEventListener('submit', add);
        $('tollTable').addEventListener('click', act);
        $('tollTable').addEventListener('change', price);
        showTab('tolls');
        $('fOnly').value = 'review';
        await status();
        listsStatus().catch(() => {});
        await load();
    });
})();
