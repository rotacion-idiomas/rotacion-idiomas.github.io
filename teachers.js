// Teacher dashboard.
(function () {
  const { createDb, formatDate, formatTime, formatDateTimePlain, escapeHtml, friendlyError,
    storageGet, storageSet, fillBranding, cfg } = window.App;

  const db = createDb();
  const SHEETJS_URL = 'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js';
  const ACTIVITY_KEY = 'rotation.teacher.activity';
  const PAGE_SIZE = 1000;

  const state = {
    activities: [],
    students: [],
    attendance: [],
    byStudent: new Map(),   // codigo -> Map(actividad_id -> attendance)
    photoUrls: new Map(),   // foto_path -> signed URL
    tab: 'activity',
  };

  const $ = (id) => document.getElementById(id);

  function showView(name) {
    ['loading', 'login', 'dash'].forEach((v) => { $(`v-${v}`).hidden = v !== name; });
  }

  function setAlert(id, message) {
    $(id).hidden = !message;
    $(`${id}-text`).textContent = message || '';
  }

  // ---------------------------------------------------------------- auth
  async function start() {
    fillBranding();
    const { data } = await db.auth.getSession();
    if (data.session) return openDashboard(data.session);
    showView('login');
  }

  $('login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = $('l-email').value.trim();
    const password = $('l-password').value;
    if (!email || !password) return setAlert('login-error', 'Please enter your email and password.');

    const button = e.target.querySelector('button');
    button.disabled = true;
    button.textContent = 'Signing in…';
    const { data, error } = await db.auth.signInWithPassword({ email, password });
    button.disabled = false;
    button.textContent = 'Sign in';

    if (error) {
      const wrong = /invalid login credentials/i.test(error.message);
      return setAlert('login-error', wrong ? 'Incorrect email or password.' : friendlyError(error));
    }
    setAlert('login-error', '');
    openDashboard(data.session);
  });

  $('btn-logout').addEventListener('click', async () => {
    await db.auth.signOut();
    $('user-box').hidden = true;
    $('login-form').reset();
    state.photoUrls.clear();
    showView('login');
  });

  async function openDashboard(session) {
    $('user-email').textContent = session.user.email;
    $('user-box').hidden = false;
    showView('dash');
    await loadData();
  }

  // ---------------------------------------------------------------- data
  async function fetchAll(table, columns, orderColumn) {
    const rows = [];
    for (let from = 0; ; from += PAGE_SIZE) {
      const { data, error } = await db.from(table).select(columns)
        .order(orderColumn).range(from, from + PAGE_SIZE - 1);
      if (error) throw error;
      rows.push(...data);
      if (data.length < PAGE_SIZE) return rows;
    }
  }

  async function loadData() {
    const button = $('btn-refresh');
    button.disabled = true;
    try {
      const [activities, students, attendance] = await Promise.all([
        fetchAll('actividades', 'id, nombre, salon, profesor, orden', 'orden'),
        fetchAll('estudiantes', 'codigo, nombre, grado, creado_en', 'codigo'),
        fetchAll('asistencias', 'id, estudiante_codigo, actividad_id, registrado_en, foto_path', 'id'),
      ]);
      state.activities = activities;
      state.students = students.sort((a, b) => a.nombre.localeCompare(b.nombre, 'es'));
      state.attendance = attendance;
      state.byStudent = new Map(students.map((s) => [s.codigo, new Map()]));
      attendance.forEach((a) => {
        if (!state.byStudent.has(a.estudiante_codigo)) state.byStudent.set(a.estudiante_codigo, new Map());
        state.byStudent.get(a.estudiante_codigo).set(a.actividad_id, a);
      });
      setAlert('dash-error', '');
      $('last-update').textContent = `Last updated: ${formatDate(new Date())}, ${formatTime(new Date())}`;
      fillActivitySelect();
      render();
    } catch (err) {
      console.error(err);
      if (err && /JWT|session|401/i.test(err.message || '')) {
        await db.auth.signOut();
        return showView('login');
      }
      setAlert('dash-error', friendlyError(err));
    } finally {
      button.disabled = false;
    }
  }
  $('btn-refresh').addEventListener('click', loadData);

  function studentByCode(code) {
    return state.students.find((s) => s.codigo === code) || { codigo: code, nombre: '(unknown)', grado: '' };
  }

  function completedCount(code) {
    const done = state.byStudent.get(code);
    return done ? state.activities.filter((a) => done.has(a.id)).length : 0;
  }

  function matches(student, query) {
    if (!query) return true;
    const q = query.toLowerCase();
    return student.nombre.toLowerCase().includes(q) || student.codigo.toLowerCase().includes(q);
  }

  // ---------------------------------------------------------------- rendering
  function render() {
    renderStats();
    if (state.tab === 'activity') renderActivity(); else renderOverview();
  }

  function renderStats() {
    const total = state.activities.length;
    const finished = state.students.filter((s) => completedCount(s.codigo) >= total && total > 0).length;
    const stats = [
      [state.students.length, 'Students registered'],
      [state.attendance.length, 'Total check-ins'],
      [finished, 'Completed all activities'],
      [state.students.length - finished, 'Still in progress'],
    ];
    $('stats').innerHTML = stats.map(([num, label]) =>
      `<div class="stat"><div class="num">${num}</div><div class="label">${label}</div></div>`).join('');
  }

  function fillActivitySelect() {
    const select = $('sel-activity');
    const current = select.value || storageGet(ACTIVITY_KEY);
    select.innerHTML = state.activities.map((a) =>
      `<option value="${escapeHtml(a.id)}">${escapeHtml(a.nombre)} – ${escapeHtml(a.salon)}</option>`).join('');
    if (state.activities.some((a) => a.id === current)) select.value = current;
  }

  $('sel-activity').addEventListener('change', (e) => {
    storageSet(ACTIVITY_KEY, e.target.value);
    renderActivity();
  });
  $('search-activity').addEventListener('input', renderActivity);
  $('search-overview').addEventListener('input', renderOverview);
  $('only-incomplete').addEventListener('change', renderOverview);

  async function renderActivity() {
    const activity = state.activities.find((a) => a.id === $('sel-activity').value);
    const tbody = $('activity-rows');
    if (!activity) {
      $('activity-info').textContent = '';
      tbody.innerHTML = '<tr><td colspan="6" class="empty">No activities yet.</td></tr>';
      return;
    }

    const query = $('search-activity').value.trim();
    const all = state.attendance
      .filter((a) => a.actividad_id === activity.id)
      .sort((x, y) => new Date(y.registrado_en) - new Date(x.registrado_en));
    const rows = all.filter((a) => matches(studentByCode(a.estudiante_codigo), query));

    $('activity-info').innerHTML = `<strong>${escapeHtml(activity.nombre)}</strong> · ${escapeHtml(activity.salon)} · ${escapeHtml(activity.profesor)}
      — ${all.length} ${all.length === 1 ? 'student' : 'students'} checked in`;

    if (!rows.length) {
      tbody.innerHTML = `<tr><td colspan="6" class="empty">${query ? 'No students match your search.' : 'No check-ins yet for this activity.'}</td></tr>`;
      return;
    }

    tbody.innerHTML = rows.map((a) => {
      const s = studentByCode(a.estudiante_codigo);
      return `<tr>
        <td><button class="thumb" type="button" data-path="${escapeHtml(a.foto_path)}" aria-label="View photo of ${escapeHtml(s.nombre)}"><img alt="" data-src-path="${escapeHtml(a.foto_path)}"></button></td>
        <td><strong>${escapeHtml(s.nombre)}</strong></td>
        <td class="nowrap">${escapeHtml(s.codigo)}</td>
        <td>${escapeHtml(s.grado)}</td>
        <td class="nowrap">${formatDate(a.registrado_en)}</td>
        <td class="nowrap">${formatTime(a.registrado_en)}</td>
      </tr>`;
    }).join('');

    await loadPhotoUrls(rows.map((a) => a.foto_path));
    tbody.querySelectorAll('img[data-src-path]').forEach((img) => {
      const url = state.photoUrls.get(img.dataset.srcPath);
      if (url) img.src = url;
    });
  }

  // Private photos: ask Supabase for temporary links (valid 1 hour).
  async function loadPhotoUrls(paths) {
    const missing = [...new Set(paths)].filter((p) => !state.photoUrls.has(p));
    for (let i = 0; i < missing.length; i += 100) {
      const chunk = missing.slice(i, i + 100);
      const { data, error } = await db.storage.from('evidencias').createSignedUrls(chunk, 3600);
      if (error) { console.error(error); continue; }
      data.forEach((d) => { if (d.signedUrl) state.photoUrls.set(d.path, d.signedUrl); });
    }
  }

  function renderOverview() {
    const total = state.activities.length;
    $('overview-head').innerHTML = `<tr>
      <th>Student</th><th>Student ID</th><th>Course / Group</th>
      ${state.activities.map((a) => `<th class="c">${escapeHtml(a.nombre)}</th>`).join('')}
      <th class="c">Done</th><th>Status</th>
    </tr>`;

    const query = $('search-overview').value.trim();
    const onlyIncomplete = $('only-incomplete').checked;
    const rows = state.students
      .filter((s) => matches(s, query))
      .filter((s) => !onlyIncomplete || completedCount(s.codigo) < total);

    if (!rows.length) {
      $('overview-rows').innerHTML = `<tr><td colspan="${total + 5}" class="empty">${
        state.students.length ? 'No students match these filters.' : 'No students registered yet.'}</td></tr>`;
      return;
    }

    $('overview-rows').innerHTML = rows.map((s) => {
      const done = state.byStudent.get(s.codigo) || new Map();
      const count = completedCount(s.codigo);
      const complete = count >= total;
      const cells = state.activities.map((a) => {
        const record = done.get(a.id);
        return record
          ? `<td class="c"><span class="yes" title="${escapeHtml(formatDate(record.registrado_en) + ', ' + formatTime(record.registrado_en))}">✓</span></td>`
          : '<td class="c"><span class="no" title="Not yet">✗</span></td>';
      }).join('');
      return `<tr class="${complete ? '' : 'is-incomplete'}">
        <td><strong>${escapeHtml(s.nombre)}</strong></td>
        <td class="nowrap">${escapeHtml(s.codigo)}</td>
        <td>${escapeHtml(s.grado)}</td>
        ${cells}
        <td class="c nowrap"><strong>${count}/${total}</strong></td>
        <td>${complete
          ? '<span class="badge badge-done">Complete</span>'
          : '<span class="badge badge-pending">Incomplete</span>'}</td>
      </tr>`;
    }).join('');
  }

  // ---------------------------------------------------------------- tabs
  function selectTab(tab) {
    state.tab = tab;
    $('tab-activity').setAttribute('aria-selected', String(tab === 'activity'));
    $('tab-overview').setAttribute('aria-selected', String(tab === 'overview'));
    $('p-activity').hidden = tab !== 'activity';
    $('p-overview').hidden = tab !== 'overview';
    render();
  }
  $('tab-activity').addEventListener('click', () => selectTab('activity'));
  $('tab-overview').addEventListener('click', () => selectTab('overview'));

  // ---------------------------------------------------------------- lightbox
  $('activity-rows').addEventListener('click', async (e) => {
    const button = e.target.closest('button.thumb');
    if (!button) return;
    const path = button.dataset.path;
    const record = state.attendance.find((a) => a.foto_path === path);
    const student = studentByCode(record.estudiante_codigo);
    const activity = state.activities.find((a) => a.id === record.actividad_id);
    await loadPhotoUrls([path]);
    $('lightbox-img').src = state.photoUrls.get(path) || '';
    $('lightbox-img').alt = `Photo of ${student.nombre}`;
    $('lightbox-caption').textContent =
      `${student.nombre} (${student.codigo}) · ${activity ? activity.nombre : ''} · ${formatDate(record.registrado_en)}, ${formatTime(record.registrado_en)}`;
    $('lightbox').hidden = false;
    $('lightbox-close').focus();
  });

  function closeLightbox() {
    $('lightbox').hidden = true;
    $('lightbox-img').removeAttribute('src');
  }
  $('lightbox-close').addEventListener('click', closeLightbox);
  $('lightbox').addEventListener('click', (e) => { if (e.target.id === 'lightbox') closeLightbox(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('lightbox').hidden) closeLightbox(); });

  // ---------------------------------------------------------------- Excel
  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = src;
      script.onload = resolve;
      script.onerror = () => reject(new Error('Failed to fetch the Excel library'));
      document.head.appendChild(script);
    });
  }

  $('btn-download').addEventListener('click', async () => {
    const button = $('btn-download');
    button.disabled = true;
    try {
      if (!window.XLSX) await loadScript(SHEETJS_URL);
      downloadWorkbook();
      setAlert('dash-error', '');
    } catch (err) {
      console.error(err);
      setAlert('dash-error', friendlyError(err));
    } finally {
      button.disabled = false;
    }
  });

  function downloadWorkbook() {
    const XLSX = window.XLSX;
    const total = state.activities.length;

    const overview = state.students.map((s) => {
      const done = state.byStudent.get(s.codigo) || new Map();
      const row = { 'Student ID': s.codigo, 'Full name': s.nombre, 'Course / Group': s.grado };
      state.activities.forEach((a) => {
        const record = done.get(a.id);
        row[a.nombre] = record ? formatDateTimePlain(record.registrado_en) : '';
      });
      const count = completedCount(s.codigo);
      row['Completed'] = `${count}/${total}`;
      row['Status'] = count >= total ? 'Complete' : 'Incomplete';
      return row;
    });

    const checkIns = [...state.attendance]
      .sort((x, y) => x.actividad_id.localeCompare(y.actividad_id) || new Date(x.registrado_en) - new Date(y.registrado_en))
      .map((a) => {
        const s = studentByCode(a.estudiante_codigo);
        const act = state.activities.find((x) => x.id === a.actividad_id) || {};
        return {
          'Activity': act.nombre || a.actividad_id,
          'Room': act.salon || '',
          'Teacher': act.profesor || '',
          'Student ID': s.codigo,
          'Full name': s.nombre,
          'Course / Group': s.grado,
          'Check-in (Bogotá time)': formatDateTimePlain(a.registrado_en),
        };
      });

    const book = XLSX.utils.book_new();
    const sheet1 = XLSX.utils.json_to_sheet(overview.length ? overview : [{ 'Student ID': '' }]);
    const sheet2 = XLSX.utils.json_to_sheet(checkIns.length ? checkIns : [{ 'Activity': '' }]);
    sheet1['!cols'] = [{ wch: 14 }, { wch: 32 }, { wch: 22 }, ...state.activities.map(() => ({ wch: 17 })), { wch: 11 }, { wch: 12 }];
    sheet2['!cols'] = [{ wch: 14 }, { wch: 12 }, { wch: 30 }, { wch: 14 }, { wch: 32 }, { wch: 22 }, { wch: 22 }];
    XLSX.utils.book_append_sheet(book, sheet1, 'Overview');
    XLSX.utils.book_append_sheet(book, sheet2, 'Check-ins');

    const stamp = formatDateTimePlain(new Date()).replace(/[: ]/g, '-');
    XLSX.writeFile(book, `${cfg.EVENT_TITLE.replace(/\s+/g, '-')}-attendance-${stamp}.xlsx`);
  }

  start();
})();
