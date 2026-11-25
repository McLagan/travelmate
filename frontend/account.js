/* Account pages: password reset and email confirmation links (/reset-password, /verify-email),
   plus the "Security" block on the profile page. */
(function () {
    const $ = (id) => document.getElementById(id);
    const base = (window.CONFIG && window.CONFIG.API_BASE_URL) || '';

    async function post(path, body, token) {
        const r = await fetch(`${base}${path}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
            body: JSON.stringify(body || {}),
        });
        let data = null;
        try { data = await r.json(); } catch (e) { /* empty */ }
        if (!r.ok) {
            const d = data && data.detail;
            throw new Error(typeof d === 'string' ? d : Array.isArray(d) ? d.map(x => x.msg).join('; ') : `Error ${r.status}`);
        }
        return data;
    }

    function esc(s) {
        return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    }

    // ---------- /reset-password and /verify-email ----------
    function accountPage() {
        const msg = (text, ok) => {
            const el = $('accountMsg');
            el.textContent = text;
            el.className = `account-msg ${ok ? 'ok' : 'err'}`;
            el.style.display = 'block';
        };
        // take the token and remove it from the address bar / history at once
        const token = new URLSearchParams(location.hash.slice(1)).get('token');
        history.replaceState(null, '', location.pathname);
        if (!token) { msg('This link is incomplete. Open it again from the email, or request a new one.', false); return; }

        if (location.pathname.startsWith('/verify-email')) {
            msg('Confirming your email…', true);
            post('/auth/verify-email', { token })
                .then(r => { msg(r.message, true); $('accountNext').textContent = 'Open TravelMate'; $('accountNext').style.display = 'block'; })
                .catch(e => msg(e.message, false));
            return;
        }

        const form = $('resetForm');
        form.style.display = 'flex';
        $('newPassword').focus();
        form.addEventListener('submit', async (e) => {
            e.preventDefault();
            const p1 = $('newPassword').value, p2 = $('newPassword2').value;
            if (p1.length < 10) { msg('The password must be at least 10 characters.', false); return; }
            if (p1 !== p2) { msg('The two passwords are different.', false); return; }
            const btn = form.querySelector('button');
            btn.disabled = true;
            try {
                const r = await post('/auth/reset-password', { token, password: p1 });
                localStorage.removeItem('token');           // an old session on this browser is no longer valid
                form.style.display = 'none';
                msg(r.message, true);
                $('accountNext').style.display = 'block';
            } catch (err) {
                msg(err.message, false);
            } finally {
                btn.disabled = false;
            }
        });
    }

    // ---------- profile: "Security" block ----------
    const Security = {
        async mount(box) {
            this.box = box;
            const token = localStorage.getItem('token');
            if (!token) return;
            try {
                const r = await fetch(`${base}/auth/me`, { headers: { Authorization: `Bearer ${token}` } });
                this.user = r.ok ? await r.json() : null;
            } catch (e) { this.user = null; }
            this.render();
        },

        render(note, ok) {
            const u = this.user;
            if (!u) { this.box.innerHTML = '<p class="tb-note">Could not load account data.</p>'; return; }
            this.box.innerHTML = `
                <div class="sec-row">
                    <div><b>Email</b><br><span>${esc(u.email)}</span>
                        ${u.email_verified ? '<span class="sec-badge ok">✓ confirmed</span>' : '<span class="sec-badge warn">not confirmed</span>'}</div>
                    ${u.email_verified ? '' : '<button class="btn btn-secondary btn-sm" data-act="resend">Send confirmation link</button>'}
                </div>
                <form class="sec-form" data-form="pw">
                    <b>Change password</b>
                    <input type="password" class="form-input" name="cur" placeholder="Current password" autocomplete="current-password" required>
                    <input type="password" class="form-input" name="new1" placeholder="New password (at least 10 characters)" minlength="10" autocomplete="new-password" required>
                    <input type="password" class="form-input" name="new2" placeholder="Repeat the new password" minlength="10" autocomplete="new-password" required>
                    <button class="btn btn-primary btn-sm" type="submit">Change password</button>
                </form>
                <div class="sec-row">
                    <div><b>Other devices</b><br><span class="tb-note">Signed in on a shared computer or lost a phone?</span></div>
                    <button class="btn btn-secondary btn-sm" data-act="logoutAll">Sign out everywhere else</button>
                </div>
                <p class="tb-note">Changing the password also signs you out on all other devices.</p>
                ${note ? `<div class="account-msg ${ok ? 'ok' : 'err'}">${esc(note)}</div>` : ''}`;
            this.box.querySelector('[data-act=resend]')?.addEventListener('click', () => this.resend());
            this.box.querySelector('[data-act=logoutAll]').addEventListener('click', () => this.logoutAll());
            this.box.querySelector('[data-form=pw]').addEventListener('submit', (e) => this.changePassword(e));
        },

        async resend() {
            try { const r = await post('/auth/resend-verification', {}, localStorage.getItem('token')); this.render(r.message, true); }
            catch (e) { this.render(e.message, false); }
        },

        async changePassword(e) {
            e.preventDefault();
            const f = e.target;
            if (f.new1.value !== f.new2.value) { this.render('The two new passwords are different.', false); return; }
            try {
                const r = await post('/auth/change-password', { current_password: f.cur.value, new_password: f.new1.value },
                                     localStorage.getItem('token'));
                localStorage.setItem('token', r.access_token);
                this.render('Password changed. Other devices have been signed out.', true);
            } catch (err) { this.render(err.message, false); }
        },

        async logoutAll() {
            try {
                const r = await post('/auth/logout-all', {}, localStorage.getItem('token'));
                localStorage.setItem('token', r.access_token);
                this.render('Done: every other device has been signed out.', true);
            } catch (e) { this.render(e.message, false); }
        },
    };
    window.AccountSecurity = Security;

    document.addEventListener('DOMContentLoaded', () => {
        if ($('resetForm')) accountPage();
        const box = $('securityBox');
        if (box) Security.mount(box);
    });
})();
