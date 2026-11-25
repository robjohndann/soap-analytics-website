/* ==========================================================================
   SOAP Analytics V82 — mfa-gate.js  (LOCAL DEVELOPMENT VERSION 0.1)

   Shared client-side MFA gate. UI ROUTING ONLY — NOT A SECURITY BOUNDARY.
   The security boundary is the server: Migration 3 RLS, Migration 4 guarded
   RPCs and the Edge Functions all re-check the session's AAL and freshness.
   This file decides where to send the person and what to show; if it is
   bypassed, deleted or wrong, the database still refuses the data.

   Requires: a supabase-js client (v2.119.0) created by the host page.
   Exposes:  window.SoapMfaGate
     .require(sb, {schoolId, returnTo, navigate})   ordinary-access gate
     .requireFresh(sb, {returnTo, navigate})        fresh-TOTP gate (admin actions)
     .evaluate(sb, {schoolId})                      pure check, never navigates
   v0.2 (Migration 6): a REVOKED session (the database now answers no rows to a dead token) is confirmed with Auth (getUser), the local
   copy is cleared, and the state is 'no_session' with ended:true, so every page's existing "please log in" handling applies and login.html
   shows its form instead of forwarding the stale local session.
     .safeReturn(raw, fallback)                     return-URL validator
     .mapError(err)                                 server MFA error -> message/action
     .renderBlock(kind, opts)                       full-page "cannot continue" panel
     .signOutAndLeave(sb)                           sign out, go to login.html
     .inFrame()                                     true inside any iframe

   Every function FAILS CLOSED: ok === true only when the server has said so.
   Never navigates inside an iframe (admin publish workflows use hidden iframes).
   ========================================================================== */
(function () {
  'use strict';

  var MFA_PAGE = 'mfa.html';
  var LOGIN_PAGE = 'login.html';
  var DEFAULT_RETURN = 'portal.html';

  // Pages a person may be sent back to after MFA. Anything else is refused.
  // Deliberately EXCLUDES mfa, login and index (redirect-loop / open-redirect safety).
  var RETURN_ALLOWED = {
    'portal': 1, 'admin': 1,
    'soap-dashboard': 1, 'soap-page': 1, 'exemplar-soap': 1,
    'idsr-soap': 1, 'idsr-dashboard': 1,
    'school-setup-form': 1, 'set-password': 1, 'security-settings': 1,
    'achievement-form': 1, 'attendance-form': 1, 'context-form': 1,
    'curriculum-form': 1, 'finance-form': 1, 'inclusion-form': 1,
    'leadership-form': 1, 'pdw-form': 1, 'safeguarding-form': 1
  };

  var UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  function inFrame() {
    try { return window.self !== window.top; } catch (e) { return true; } // cross-origin top => treat as framed
  }

  // ---- return-URL validation ------------------------------------------------
  // Returns a relative "<page>.html[?safe=params]" or the fallback. Never an absolute URL,
  // never a protocol-relative URL, never a hash, never a page outside RETURN_ALLOWED.
  function safeReturn(raw, fallback) {
    var fb = fallback || DEFAULT_RETURN;
    try {
      if (typeof raw !== 'string' || !raw || raw.length > 600) return fb;
      if (/[\u0000-\u001f\u007f\\\s]/.test(raw)) return fb;          // control chars, backslash, whitespace
      if (/^[a-z][a-z0-9+.\-]*:/i.test(raw)) return fb;               // any scheme (javascript:, https:, data:)
      if (raw.charAt(0) === '/' && raw.charAt(1) === '/') return fb;  // protocol-relative
      var u = new URL(raw, window.location.origin + '/');
      if (u.origin !== window.location.origin) return fb;
      var name = u.pathname.replace(/^\/+/, '').replace(/\.html$/, '');
      if (!Object.prototype.hasOwnProperty.call(RETURN_ALLOWED, name)) return fb;
      var kept = [];
      u.searchParams.forEach(function (v, k) {
        if (/^[a-z_]{1,30}$/.test(k) && /^[A-Za-z0-9_.\-]{0,80}$/.test(v)) {
          kept.push(encodeURIComponent(k) + '=' + encodeURIComponent(v));
        }
      });
      return name + '.html' + (kept.length ? '?' + kept.join('&') : '');
    } catch (e) { return fb; }
  }

  function currentReturn() {
    // Page name + query, as the host page was loaded (pretty URLs: /portal -> portal.html).
    var path = window.location.pathname.replace(/^\/+/, '') || '';
    return safeReturn(path + window.location.search, DEFAULT_RETURN);
  }

  // ---- loop guard (defence in depth; the server decides, this only bounds retries) ----
  var TRIP_KEY = 'soap_mfa_gate_trips';
  function tripsExceeded() {
    try {
      var now = Date.now();
      var arr = JSON.parse(sessionStorage.getItem(TRIP_KEY) || '[]').filter(function (t) { return now - t < 60000; });
      arr.push(now);
      sessionStorage.setItem(TRIP_KEY, JSON.stringify(arr));
      return arr.length > 4;
    } catch (e) { return false; }   // storage unavailable: the mfa.html 'blocked' state still prevents a loop
  }
  function clearTrips() { try { sessionStorage.removeItem(TRIP_KEY); } catch (e) {} }

  // ---- server facts -----------------------------------------------------------
  async function rpcRows(sb, name) {
    var r = await sb.rpc(name);
    if (r.error) { var e = new Error(name + ': ' + (r.error.message || 'failed')); e.cause = r.error; throw e; }
    return Array.isArray(r.data) ? r.data : (r.data ? [r.data] : []);
  }

  // V82 Migration 6: has Auth really ended this session? The database answers "no rows" to my_mfa_session for a dead token, but an
  // empty answer alone is not proof, so Auth is asked. true only on a definite refusal (4xx / session missing); a network error or an
  // unexpected answer is "unknown" (false) and the caller keeps failing closed as 'error'.
  async function sessionEnded(sb) {
    try {
      var r = await sb.auth.getUser();
      if (r && r.data && r.data.user && !r.error) return false;
      var er = r && r.error;
      if (!er) return true;
      var st = typeof er.status === 'number' ? er.status : null;
      var tag = [er.name, er.code, er.message].filter(Boolean).join(' ');
      if (/RetryableFetch|FetchError|network/i.test(tag)) return false;
      return (st !== null && st >= 400 && st < 500) || /SessionMissing|session_not_found|session_expired|bad_jwt|invalid_jwt|jwt expired|user_not_found/i.test(tag);
    } catch (e) { return false; }
  }
  function looksLikeAuthRefusal(cause) {
    if (!cause) return false;
    var t = [cause.code, cause.message, cause.details].filter(Boolean).join(' ');
    return cause.status === 401 || /PGRST30[123]|jwt|not authenticated|session/i.test(t);
  }
  // Clear the local copy of an ended session so login.html shows its form (it forwards any local session). Returns true if none remains.
  async function clearEnded(sb) {
    try { await sb.auth.signOut({ scope: 'local' }); } catch (e) { /* the library clears local state regardless */ }
    try { var s = await sb.auth.getSession(); return !(s && s.data && s.data.session); } catch (e) { return false; }
  }
  async function endedResult(sb, res) {
    res.state = 'no_session'; res.ended = true; res.cleared = await clearEnded(sb);
    return res;
  }

  // Pure evaluation. state: no_session | ok | needs_mfa | blocked | error
  async function evaluate(sb, opts) {
    opts = opts || {};
    var res = { ok: false, state: 'error', aal: null, isAdmin: false, schools: [], session: null };
    try {
      var s = await sb.auth.getSession();
      if (!s || !s.data || !s.data.session) { res.state = 'no_session'; return res; }

      var sessRows;
      try { sessRows = await rpcRows(sb, 'my_mfa_session'); }
      catch (e0) { if (looksLikeAuthRefusal(e0.cause) && await sessionEnded(sb)) return await endedResult(sb, res); throw e0; }
      var sess = sessRows[0];
      if (!sess && await sessionEnded(sb)) return await endedResult(sb, res);   // V82 M6: revoked session (the database returns no rows)
      if (!sess || (sess.aal !== 'aal1' && sess.aal !== 'aal2')) throw new Error('my_mfa_session: unexpected result');
      var schools = await rpcRows(sb, 'my_school_mfa_status');
      res.session = sess; res.schools = schools; res.aal = sess.aal; res.isAdmin = sess.is_platform_admin === true;

      var satisfied;
      if (res.isAdmin) {
        // Administrators: separate setting. Satisfied at aal2, or while the admin MFA setting is time-limited OFF.
        satisfied = sess.aal === 'aal2' || sess.admin_mfa_off === true;
      } else {
        var rel = schools;
        if (opts.schoolId && UUID_RE.test(opts.schoolId)) {
          var m = schools.filter(function (r) { return r.school_id === opts.schoolId; });
          if (m.length) rel = m;      // judged by the school whose data is being opened; unknown school => judge on all
        }
        // No linked schools: nothing to protect here; the page's own "not linked" handling applies.
        satisfied = rel.every(function (r) { return r.session_satisfies_policy === true; });
      }

      if (satisfied) { res.ok = true; res.state = 'ok'; return res; }
      // Not satisfied. At aal1 a code can fix it. At aal2 it cannot (e.g. no settings row): do NOT loop.
      res.state = sess.aal === 'aal2' ? 'blocked' : 'needs_mfa';
      return res;
    } catch (e) {
      res.state = 'error'; res.error = e;   // FAIL CLOSED
      return res;
    }
  }

  function mfaUrl(mode, returnTo, schoolId) {
    var q = [];
    if (mode && mode !== 'gate') q.push('mode=' + encodeURIComponent(mode));
    q.push('return=' + encodeURIComponent(safeReturn(returnTo, DEFAULT_RETURN)));
    if (schoolId && UUID_RE.test(schoolId)) q.push('school_id=' + encodeURIComponent(schoolId));
    return MFA_PAGE + '?' + q.join('&');
  }

  function notifyParent(state) {
    try { window.parent.postMessage({ type: 'soap-mfa-blocked', state: state }, window.location.origin); } catch (e) {}
  }

  // Ordinary-access gate. Host page: if (!(await SoapMfaGate.require(sb,{schoolId})).ok) return;  <- before ANY data fetch
  async function requireGate(sb, opts) {
    opts = opts || {};
    var res = await evaluate(sb, opts);
    if (res.ok) { clearTrips(); return res; }
    if (res.state === 'no_session') {              // host page keeps its existing "go to login" behaviour
      // V82 M6: an ended (revoked) session whose local copy is cleared goes to the login form with a neutral notice (never inside a frame).
      if (res.ended && res.cleared && opts.navigate !== false && !inFrame()) { res.navigated = true; window.location.replace(LOGIN_PAGE + '?reason=session_ended'); }
      return res;
    }
    if (inFrame()) { notifyParent(res.state); res.navigated = false; return res; }   // never navigate a frame
    if (res.state === 'needs_mfa' && opts.navigate !== false) {
      if (tripsExceeded()) { res.state = 'blocked'; res.reason = 'loop'; renderBlock('loop',{sb:sb}); return res; }
      res.navigated = true;
      window.location.replace(mfaUrl('gate', opts.returnTo || currentReturn(), opts.schoolId));
      return res;
    }
    if (opts.navigate !== false) renderBlock(res.state === 'error' ? 'error' : 'blocked', {sb: sb});
    return res;
  }

  // Fresh-TOTP gate for sensitive admin actions. The SERVER enforces freshness on the action itself
  // (fresh_mfa_required); this only avoids a pointless failed call.
  async function requireFresh(sb, opts) {
    opts = opts || {};
    var res = { ok: false, state: 'error' };
    try {
      var s = await sb.auth.getSession();
      if (!s || !s.data || !s.data.session) { res.state = 'no_session'; return res; }
      var sess;
      try { sess = (await rpcRows(sb, 'my_mfa_session'))[0]; }
      catch (e0) { if (looksLikeAuthRefusal(e0.cause) && await sessionEnded(sb)) { var r0 = await endedResult(sb, res); return r0; } throw e0; }
      if (!sess) {
        if (await sessionEnded(sb)) return await endedResult(sb, res);   // V82 M6: revoked session
        throw new Error('my_mfa_session: empty');
      }
      res.session = sess;
      if (sess.aal === 'aal2' && sess.fresh_aal2 === true) { res.ok = true; res.state = 'fresh'; return res; }
      res.state = 'needs_stepup';
    } catch (e) { res.state = 'error'; res.error = e; return res; }
    if (inFrame()) { notifyParent(res.state); res.navigated = false; return res; }
    if (opts.navigate !== false) {
      if (tripsExceeded()) { renderBlock('loop', {sb: sb}); return res; }
      res.navigated = true;
      window.location.replace(mfaUrl('stepup', opts.returnTo || currentReturn()));
    }
    return res;
  }

  // Map a server refusal (RPC error, or Edge Function JSON) to a message and next action.
  function mapError(err) {
    var text = '';
    if (typeof err === 'string') text = err;
    else if (err) text = [err.message, err.hint, err.outcome, err.error, err.code].filter(Boolean).join(' ');
    var kind = 'other', msg = 'Something went wrong. Please try again, or contact SOAP Analytics support.', action = 'retry';
    if (/fresh_mfa_required|mfa_fresh_required/.test(text)) {
      kind = 'fresh_mfa_required'; action = 'stepup';
      msg = 'For security, please confirm a new authenticator code to continue.';
    } else if (/authenticator_not_established/.test(text)) {
      kind = 'authenticator_not_established'; action = 'signout';
      msg = 'Your authenticator was set up during this sign-in. For this action, please sign out and sign in again, then enter your code.';
    } else if (/mfa_required/.test(text)) {
      kind = 'mfa_required'; action = 'mfa';
      msg = 'Two-step verification is required. Please verify your authenticator code to continue.';
    } else if (/mfa_check_failed/.test(text)) {
      kind = 'mfa_check_failed'; action = 'retry';
      msg = 'We could not confirm your two-step verification status, so the action was not carried out. Please try again.';
    }
    return { kind: kind, message: msg, action: action };
  }

  async function signOutAndLeave(sb) {
    try { await sb.auth.signOut(); } catch (e) { /* local session is cleared by the library regardless */ }
    clearTrips();
    window.location.replace(LOGIN_PAGE);
  }

  // Minimal full-page panel used when the gate cannot let the person continue. No page data is shown.
  var COPY = {
    blocked: ['Access paused', 'Two-step verification is required for this account, but your sign-in does not meet the requirement and we cannot complete it automatically. Please contact SOAP Analytics support if this continues.'],
    error:   ['We could not check your sign-in security', 'For your protection, nothing has been loaded. Check your connection and try again.'],
    loop:    ['Verification could not be completed', 'We stopped to avoid repeating the verification step. Please sign out and sign in again. If this continues, contact SOAP Analytics support.']
  };
  function renderBlock(kind, opts) {
    if (inFrame()) return;
    opts = opts || {};
    var c = COPY[kind] || COPY.error;
    var old = document.getElementById('soapMfaBlock'); if (old) old.remove();
    var wrap = document.createElement('div');
    wrap.id = 'soapMfaBlock'; wrap.setAttribute('role', 'alert');
    wrap.style.cssText = 'position:fixed;inset:0;z-index:2147483647;background:#1B2A4A;display:flex;align-items:center;justify-content:center;padding:20px;font-family:Arial,Helvetica,sans-serif;';
    var card = document.createElement('div');
    card.style.cssText = 'background:#fff;border-radius:12px;padding:32px 30px;max-width:420px;width:100%;box-shadow:0 20px 60px rgba(0,0,0,.3);text-align:center;';
    var eb = document.createElement('div'); eb.textContent = 'SOAP Analytics';
    eb.style.cssText = 'font-size:11px;letter-spacing:2px;text-transform:uppercase;color:#0D7377;font-weight:700;margin-bottom:8px;';
    var h = document.createElement('h1'); h.textContent = c[0]; h.style.cssText = 'font-size:19px;color:#1B2A4A;margin:0 0 12px;';
    var p = document.createElement('p'); p.textContent = c[1]; p.style.cssText = 'font-size:14px;color:#3d4b5f;line-height:1.5;margin:0 0 20px;';
    var row = document.createElement('div'); row.style.cssText = 'display:flex;gap:10px;justify-content:center;flex-wrap:wrap;';
    function btn(label, primary, fn) {
      var b = document.createElement('button'); b.type = 'button'; b.textContent = label;
      b.style.cssText = 'font-size:14px;font-weight:700;border-radius:8px;padding:11px 18px;cursor:pointer;border:1px solid #0D7377;' +
        (primary ? 'background:#0D7377;color:#fff;' : 'background:#fff;color:#0D7377;');
      b.addEventListener('click', fn); return b;
    }
    if (kind !== 'blocked') row.appendChild(btn('Try again', true, function () { window.location.reload(); }));
    if (opts.sb) row.appendChild(btn('Sign out', kind === 'blocked', function () { signOutAndLeave(opts.sb); }));
    else row.appendChild(btn('Back to login', kind === 'blocked', function () { window.location.replace(LOGIN_PAGE); }));
    card.appendChild(eb); card.appendChild(h); card.appendChild(p); card.appendChild(row);
    wrap.appendChild(card); (document.body || document.documentElement).appendChild(wrap);
  }

  window.SoapMfaGate = {
    version: '0.3-local',
    require: requireGate,
    requireFresh: requireFresh,
    evaluate: evaluate,
    safeReturn: safeReturn,
    mapError: mapError,
    renderBlock: renderBlock,
    signOutAndLeave: signOutAndLeave,
    inFrame: inFrame,
    _clearTrips: clearTrips,
    _mfaUrl: mfaUrl
  };
})();
