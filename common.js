// Helpers shared by every page.
(function () {
  const cfg = window.APP_CONFIG;

  function createDb(options) {
    return window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_KEY, options);
  }

  const dateFmt = new Intl.DateTimeFormat('en-US', {
    timeZone: cfg.TIME_ZONE, weekday: 'short', month: 'short', day: 'numeric', year: 'numeric',
  });
  const timeFmt = new Intl.DateTimeFormat('en-US', {
    timeZone: cfg.TIME_ZONE, hour: 'numeric', minute: '2-digit',
  });
  const isoParts = new Intl.DateTimeFormat('en-CA', {
    timeZone: cfg.TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  });

  function formatDate(value) { return dateFmt.format(new Date(value)); }
  function formatTime(value) { return timeFmt.format(new Date(value)); }

  // "2026-10-27 14:35" in Bogotá time, for spreadsheets.
  function formatDateTimePlain(value) {
    const p = Object.fromEntries(isoParts.formatToParts(new Date(value)).map((x) => [x.type, x.value]));
    return `${p.year}-${p.month}-${p.day} ${p.hour === '24' ? '00' : p.hour}:${p.minute}`;
  }

  function escapeHtml(text) {
    return String(text ?? '').replace(/[&<>"']/g, (c) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
  }

  function friendlyError(err) {
    if (!navigator.onLine) return "You're offline. Check your internet connection and try again.";
    const msg = (err && (err.message || err.error_description)) || '';
    if (/fetch|network|load failed|timeout/i.test(msg)) {
      return "We couldn't reach the server. Check your internet connection and try again.";
    }
    return 'Something went wrong. Please try again.';
  }

  function storageGet(key) {
    try { return JSON.parse(localStorage.getItem(key)); } catch { return null; }
  }
  function storageSet(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* private mode */ }
  }
  function storageRemove(key) {
    try { localStorage.removeItem(key); } catch { /* private mode */ }
  }

  function fillBranding() {
    document.querySelectorAll('[data-event-title]').forEach((el) => { el.textContent = cfg.EVENT_TITLE; });
    document.querySelectorAll('[data-footer]').forEach((el) => { el.textContent = cfg.FOOTER; });
  }

  window.App = {
    cfg, createDb, formatDate, formatTime, formatDateTimePlain, escapeHtml, friendlyError,
    storageGet, storageSet, storageRemove, fillBranding,
  };
})();
