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

  // One or more activity names, with "+ Add another activity" (up to 10).
  function activityInputs(container, addButton, idPrefix) {
    const MAX = 10;

    function rows() { return [...container.querySelectorAll('input')]; }

    function addRow(value) {
      const n = rows().length;
      const row = document.createElement('div');
      row.className = 'activity-input';
      row.innerHTML = `<input class="input" id="${idPrefix}-${n}" autocomplete="off" maxlength="60"
          placeholder="${n ? 'Another activity' : 'e.g. Creative Writing'}" aria-label="Activity ${n + 1}">
        ${n ? '<button class="btn btn-secondary btn-small" type="button" aria-label="Remove this activity">×</button>' : ''}`;
      row.querySelector('input').value = value || '';
      const remove = row.querySelector('button');
      if (remove) remove.addEventListener('click', () => { row.remove(); addButton.hidden = false; });
      container.appendChild(row);
      addButton.hidden = rows().length >= MAX;
      return row.querySelector('input');
    }

    addButton.addEventListener('click', () => addRow('').focus());

    return {
      values: () => rows().map((i) => i.value.trim().replace(/\s+/g, ' ')).filter(Boolean),
      reset() { container.innerHTML = ''; addRow(''); addButton.hidden = false; },
    };
  }

  // "1 group" … "10 groups"
  function fillGroupCount(select, value) {
    select.innerHTML = Array.from({ length: 10 }, (_, i) =>
      `<option value="${i + 1}">${i + 1} ${i ? 'groups' : 'group'}</option>`).join('');
    select.value = String(value || 1);
  }

  // One name per group (e.g. its level), as many as the "number of groups" select says.
  function groupNameInputs(container, countSelect, idPrefix) {
    const typed = [];

    function render() {
      container.querySelectorAll('input').forEach((input, i) => { typed[i] = input.value; });
      const count = Number(countSelect.value) || 1;
      container.innerHTML = Array.from({ length: count }, (_, i) => `
        <input class="input" id="${idPrefix}-${i}" autocomplete="off" maxlength="40"
          placeholder="${count === 1 ? 'e.g. English 3 – Morning' : `Name of group ${i + 1}`}"
          aria-label="${count === 1 ? 'Name of your group' : `Name of group ${i + 1}`}">`).join('');
      container.querySelectorAll('input').forEach((input, i) => { input.value = typed[i] || ''; });
    }

    countSelect.addEventListener('change', render);

    return {
      values: () => [...container.querySelectorAll('input')].map((i) => i.value.trim().replace(/\s+/g, ' ')),
      reset(names) {
        typed.length = 0;
        (names || []).forEach((n, i) => { typed[i] = n; });
        container.innerHTML = '';
        render();
      },
    };
  }

  // The name the teacher gave the group, or "Group 2".
  function groupName(teacher, number) {
    const names = (teacher && teacher.nombres_grupos) || [];
    return names[number - 1] || `Group ${number}`;
  }

  window.App = {
    cfg, createDb, formatDate, formatTime, formatDateTimePlain, escapeHtml, friendlyError,
    storageGet, storageSet, storageRemove, fillBranding, activityInputs, fillGroupCount,
    groupNameInputs, groupName,
  };
})();
