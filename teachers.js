// Dashboard. A teacher sees the students who did their activity or chose
// them (by group) and manages their activities; the administrator sees
// everyone (with filters) and manages teachers and invitation links.
(function () {
  const { createDb, formatDate, formatTime, formatDateTimePlain, escapeHtml, friendlyError,
    fillBranding, activityInputs, fillGroupCount, cfg } = window.App;

  const db = createDb();
  const PDF_LIBS = [
    'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js',
    'https://cdnjs.cloudflare.com/ajax/libs/jspdf-autotable/3.8.2/jspdf.plugin.autotable.min.js',
  ];
  const PAGE_SIZE = 1000;

  const state = {
    activities: [],
    teachers: [],           // rows of 'profesores' (the administrator included)
    stations: [],           // teachers with activities: one column each, sorted by name
    students: [],           // every student the account can see
    attendance: [],
    byStudent: new Map(),   // codigo -> Map(profesor_id -> attendance)
    photoUrls: new Map(),   // foto_path -> signed URL
    email: '',
    me: null,               // row of the signed-in teacher
    isTeacher: false,       // accounts not in 'profesores' can't see students
    isAdmin: false,
    invites: [],
    newInvite: null,
    tab: 'results',
    renaming: null,         // id of the activity being renamed
  };

  const $ = (id) => document.getElementById(id);

  function showView(name) {
    ['loading', 'login', 'dash'].forEach((v) => { $(`v-${v}`).hidden = v !== name; });
  }

  function setAlert(id, message) {
    $(id).hidden = !message;
    $(`${id}-text`).textContent = message || '';
  }

  function activityById(id) {
    return state.activities.find((a) => a.id === id) || null;
  }

  function teacherById(id) {
    return state.teachers.find((t) => t.id === id) || null;
  }

  function nameOf(teacher) {
    return teacher.nombre || teacher.email;
  }

  function activitiesOf(teacher) {
    return state.activities.filter((a) => a.profesor_id === teacher.id);
  }

  function activeActivity(teacher) {
    return state.activities.find((a) => a.profesor_id === teacher.id && a.activa) || null;
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
    state.email = (session.user.email || '').toLowerCase();
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
      const [activities, students, attendance, teachers] = await Promise.all([
        fetchAll('actividades', 'id, nombre, salon, profesor, orden, profesor_id, activa', 'orden'),
        fetchAll('estudiantes', 'codigo, nombre, profesor_id, grupo, creado_en', 'codigo'),
        fetchAll('asistencias', 'id, estudiante_codigo, actividad_id, registrado_en, foto_path', 'id'),
        fetchAll('profesores', 'id, email, nombre, grupos, es_admin, creado_en', 'creado_en'),
      ]);
      state.activities = activities;
      state.teachers = teachers;
      state.me = teachers.find((t) => t.email === state.email) || null;
      state.isTeacher = !!state.me;
      state.isAdmin = !!(state.me && state.me.es_admin);
      state.stations = teachers.filter((t) => activitiesOf(t).length)
        .sort((a, b) => nameOf(a).localeCompare(nameOf(b), 'es'));

      state.students = students.sort((a, b) => a.nombre.localeCompare(b.nombre, 'es'));
      state.attendance = attendance;
      state.byStudent = new Map(students.map((s) => [s.codigo, new Map()]));
      attendance.forEach((a) => {
        const activity = activityById(a.actividad_id);
        const done = state.byStudent.get(a.estudiante_codigo);
        if (activity && done && !done.has(activity.profesor_id)) done.set(activity.profesor_id, a);
      });

      if (state.isAdmin) {
        const invites = await db.from('invitaciones').select('*').order('creada_en', { ascending: false });
        if (invites.error) throw invites.error;
        state.invites = invites.data;
      }

      setAlert('dash-error', '');
      $('last-update').textContent = `Last updated: ${formatDate(new Date())}, ${formatTime(new Date())}`;
      renderHeader();
      fillFilters();
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

  // ---------------------------------------------------------------- what the results show
  // Which students, for the teacher in view:
  //   'visited' everyone who did their activity, 'mine' those who chose them, 'g2' only group 2.
  function scopeOptions(teacher) {
    const own = teacher === state.me;
    const name = nameOf(teacher);
    const mine = own ? 'My students' : `Students of ${name}`;
    const options = [['visited', own ? 'Everyone who did my activity' : `Everyone who did ${name}'s activity`]];
    if (teacher.grupos > 1) {
      options.push(['mine', `${mine} – all groups`]);
      for (let g = 1; g <= teacher.grupos; g++) options.push([`g${g}`, `${mine} – Group ${g}`]);
    } else {
      options.push(['mine', mine]);
    }
    return options;
  }

  function viewTeacher() {
    return state.isAdmin ? teacherById(Number($('f-teacher').value)) : state.me;
  }

  function fillScope(select, field, value) {
    const teacher = viewTeacher();
    field.hidden = !teacher;
    if (!teacher) {
      select.innerHTML = '';
      return;
    }
    const options = scopeOptions(teacher);
    select.innerHTML = options.map(([v, label]) => `<option value="${v}">${escapeHtml(label)}</option>`).join('');
    select.value = options.some(([v]) => v === value) ? value : 'visited';
  }

  function currentView(scope = $('f-show').value) {
    const teacher = viewTeacher();
    let students = state.students;
    if (teacher) {
      if (scope === 'visited') {
        students = students.filter((s) => recordOf(s, teacher));
      } else {
        const group = scope.startsWith('g') ? Number(scope.slice(1)) : 0;
        students = students.filter((s) => s.profesor_id === teacher.id && (!group || s.grupo === group));
      }
    }
    // The teacher in view comes first, highlighted.
    const focus = teacher && state.stations.includes(teacher) ? teacher : null;
    const columns = focus ? [focus, ...state.stations.filter((t) => t !== focus)] : state.stations;
    return { teacher, scope: teacher ? scope : '', students, focus, columns };
  }

  function scopeLabel(v) {
    if (!v.teacher) return 'Every student';
    const option = scopeOptions(v.teacher).find(([value]) => value === v.scope);
    return option ? option[1] : '';
  }

  function recordOf(student, teacher) {
    const done = state.byStudent.get(student.codigo);
    return (done && done.get(teacher.id)) || null;
  }

  // One activity with each teacher completes the rotation.
  function completedCount(student) {
    return state.stations.filter((t) => recordOf(student, t)).length;
  }

  function isComplete(student) {
    return state.stations.length > 0 && completedCount(student) >= state.stations.length;
  }

  function teacherOf(student) {
    const teacher = teacherById(student.profesor_id);
    return teacher ? nameOf(teacher) : '';
  }

  function groupOf(student) {
    const teacher = teacherById(student.profesor_id);
    return teacher && teacher.grupos > 1 ? `Group ${student.grupo}` : '';
  }

  function matches(student, query) {
    if (!query) return true;
    const q = query.toLowerCase();
    return student.nombre.toLowerCase().includes(q) || student.codigo.toLowerCase().includes(q);
  }

  function summary(v) {
    const finished = v.students.filter(isComplete).length;
    const own = v.focus && v.focus === state.me;
    const checkIns = v.focus
      ? [v.students.filter((s) => recordOf(s, v.focus)).length, own ? 'Did my activity' : `Did ${nameOf(v.focus)}'s activity`]
      : [v.students.reduce((n, s) => n + completedCount(s), 0), 'Total check-ins'];
    return [
      [v.students.length, 'Students'],
      checkIns,
      [finished, 'Completed all activities'],
      [v.students.length - finished, 'Still in progress'],
    ];
  }

  function withRoom(activity) {
    return `${activity.nombre}${activity.salon ? ` – ${activity.salon}` : ''}`;
  }

  // Columns besides the teachers': the student's teacher, or their group.
  function extraColumns(v) {
    return {
      showTeacher: !v.teacher || v.scope === 'visited',
      showGroup: !!v.teacher && v.scope === 'mine' && v.teacher.grupos > 1,
    };
  }

  // ---------------------------------------------------------------- rendering
  function renderHeader() {
    const me = state.me;
    const teaching = state.isTeacher && !state.isAdmin;
    $('dash-role').textContent = state.isAdmin ? 'Administrator' : 'My students';
    $('admin-tabs').hidden = !state.isAdmin;
    $('p-mine').hidden = !teaching;
    document.querySelectorAll('[data-admin-only]').forEach((el) => { el.hidden = !state.isAdmin; });
    let info;
    if (state.isAdmin) {
      info = 'You can see every teacher\'s results and manage the teachers.';
    } else if (teaching) {
      const active = activeActivity(me);
      info = `<strong>${escapeHtml(nameOf(me))}</strong> · ${active
        ? `Active now: ${escapeHtml(withRoom(active))}`
        : 'You have no active activity yet.'}`;
      $('mine-qr').href = `qr.html?teacher=${encodeURIComponent(me.id)}`;
    } else {
      info = 'This account isn\'t registered as a teacher. Please create your account with the sign-up link you received.';
    }
    $('teacher-info').innerHTML = info;
    selectTab(state.isAdmin ? state.tab : 'results');
  }

  function fillFilters() {
    if (state.isAdmin) {
      const select = $('f-teacher');
      const current = select.value;
      select.innerHTML = '<option value="">All teachers</option>' + state.stations.map((t) =>
        `<option value="${t.id}">${escapeHtml(nameOf(t))}</option>`).join('');
      select.value = state.stations.some((t) => String(t.id) === current) ? current : '';
    }
    fillScope($('f-show'), $('f-show-field'), $('f-show').value);
  }

  function render() {
    $('stats').innerHTML = summary(currentView()).map(([num, label]) =>
      `<div class="stat"><div class="num">${num}</div><div class="label">${escapeHtml(label)}</div></div>`).join('');
    renderTable();
    if (state.isTeacher && !state.isAdmin) renderActivityManager($('mine-activities'), state.me);
    if (state.isAdmin) {
      renderTeachers();
      renderInvites();
      if (editing && !$('teacher-modal').hidden) {
        editing = state.teachers.find((t) => t.email === editing.email) || editing;
        renderActivityManager($('tm-activity-manager'), editing);
      }
    }
  }

  $('f-teacher').addEventListener('change', () => {
    fillScope($('f-show'), $('f-show-field'), 'visited');
    render();
  });
  $('f-show').addEventListener('change', render);
  $('search').addEventListener('input', renderTable);
  $('only-incomplete').addEventListener('change', renderTable);

  // Photo, time and activity of the student's check-in with this teacher.
  function stationCell(student, teacher, isFocus) {
    const r = recordOf(student, teacher);
    const mine = isFocus ? 'mine' : '';
    if (!r) return `<td class="c ${mine}"><span class="no" title="Not yet">✗</span></td>`;
    const activity = activityById(r.actividad_id);
    const name = activity ? activity.nombre : '';
    return `<td class="${mine}"><div class="photo-cell">
        <button class="thumb" type="button" data-path="${escapeHtml(r.foto_path)}" aria-label="View photo of ${escapeHtml(student.nombre)} at ${escapeHtml(name)}"><img alt="" loading="lazy" data-src-path="${escapeHtml(r.foto_path)}"></button>
        <span class="cell-meta"><span class="nowrap"><span class="yes">✓</span> ${formatTime(r.registrado_en)}</span><span class="muted">${escapeHtml(name)}</span></span>
      </div></td>`;
  }

  async function renderTable() {
    const v = currentView();
    const total = state.stations.length;
    const { showTeacher, showGroup } = extraColumns(v);
    const columns = 4 + (showTeacher ? 1 : 0) + (showGroup ? 1 : 0) + v.columns.length + (state.isAdmin ? 1 : 0);

    $('students-head').innerHTML = `<tr>
      <th>Student</th><th>Student ID</th>
      ${showTeacher ? '<th>Teacher</th>' : ''}
      ${showGroup ? '<th>Group</th>' : ''}
      ${v.columns.map((t) => `<th class="${t === v.focus ? 'mine' : 'c'}">${escapeHtml(nameOf(t))}</th>`).join('')}
      <th class="c">Done</th><th>Status</th>
      ${state.isAdmin ? '<th></th>' : ''}
    </tr>`;

    const query = $('search').value.trim();
    const onlyIncomplete = $('only-incomplete').checked;
    const rows = v.students
      .filter((s) => matches(s, query))
      .filter((s) => !onlyIncomplete || !isComplete(s));

    const tbody = $('students-rows');
    if (!rows.length) {
      let empty = 'No students match these filters.';
      if (!v.students.length) {
        if (!v.teacher) empty = 'No students registered yet.';
        else if (v.scope === 'visited') empty = 'No students have checked in to this teacher\'s activity yet.';
        else empty = v.teacher === state.me ? 'No students have chosen you as their teacher yet.' : 'No students have chosen this teacher yet.';
      }
      tbody.innerHTML = `<tr><td colspan="${columns}" class="empty">${empty}</td></tr>`;
      return;
    }

    tbody.innerHTML = rows.map((s) => {
      const complete = isComplete(s);
      const group = groupOf(s);
      return `<tr class="${complete ? '' : 'is-incomplete'}">
        <td><strong>${escapeHtml(s.nombre)}</strong></td>
        <td class="nowrap">${escapeHtml(s.codigo)}</td>
        ${showTeacher ? `<td>${escapeHtml(teacherOf(s)) || '<span class="muted">—</span>'}${group ? `<br><span class="muted small">${group}</span>` : ''}</td>` : ''}
        ${showGroup ? `<td class="nowrap">${group}</td>` : ''}
        ${v.columns.map((t) => stationCell(s, t, t === v.focus)).join('')}
        <td class="c nowrap"><strong>${completedCount(s)}/${total}</strong></td>
        <td>${complete
          ? '<span class="badge badge-done">Complete</span>'
          : '<span class="badge badge-pending">Incomplete</span>'}</td>
        ${state.isAdmin ? `<td><button class="btn btn-secondary btn-small btn-danger" type="button" data-delete-student="${escapeHtml(s.codigo)}">Delete</button></td>` : ''}
      </tr>`;
    }).join('');

    // Every photo is shown; the browser only downloads the ones on screen.
    const paths = [...tbody.querySelectorAll('img[data-src-path]')].map((img) => img.dataset.srcPath);
    await loadPhotoUrls(paths);
    tbody.querySelectorAll('img[data-src-path]').forEach((img) => {
      const url = state.photoUrls.get(img.dataset.srcPath);
      if (url) img.src = url;
    });
  }

  // Private photos: ask Supabase for temporary links (valid 1 hour).
  async function loadPhotoUrls(paths) {
    const missing = [...new Set(paths)].filter((p) => !state.photoUrls.has(p));
    const chunks = [];
    for (let i = 0; i < missing.length; i += 200) chunks.push(missing.slice(i, i + 200));
    await Promise.all(chunks.map(async (chunk) => {
      const { data, error } = await db.storage.from('evidencias').createSignedUrls(chunk, 3600);
      if (error) return console.error(error);
      data.forEach((d) => { if (d.signedUrl) state.photoUrls.set(d.path, d.signedUrl); });
    }));
  }

  // ---------------------------------------------------------------- activities (teacher, or administrator in "Edit")
  // Only one activity is active: the one students can check in to.
  function renderActivityManager(container, teacher) {
    const list = activitiesOf(teacher);
    const rows = list.map((a) => {
      const checkIns = state.attendance.filter((x) => x.actividad_id === a.id).length;
      if (state.renaming === a.id) {
        return `<div class="act-row">
          <input class="input" maxlength="60" value="${escapeHtml(a.nombre)}" data-rename-input aria-label="New name for ${escapeHtml(a.nombre)}">
          <div class="invite-actions">
            <button class="btn btn-small" type="button" data-rename-save="${escapeHtml(a.id)}">Save</button>
            <button class="btn btn-secondary btn-small" type="button" data-rename-cancel>Cancel</button>
          </div>
        </div>`;
      }
      return `<div class="act-row ${a.activa ? 'is-active' : ''}">
        <div>
          <strong>${escapeHtml(a.nombre)}</strong>
          ${a.activa ? '<span class="badge badge-done">Active</span>' : '<span class="badge badge-off">Inactive</span>'}
          <br><span class="muted" style="font-size:14px">${checkIns} ${checkIns === 1 ? 'check-in' : 'check-ins'}</span>
        </div>
        <div class="invite-actions">
          ${a.activa ? '' : `<button class="btn btn-small" type="button" data-activate="${escapeHtml(a.id)}">Activate</button>`}
          <a class="btn btn-secondary btn-small" href="qr.html?activity=${encodeURIComponent(a.id)}" target="_blank" rel="noopener">QR code</a>
          <button class="btn btn-secondary btn-small" type="button" data-rename="${escapeHtml(a.id)}">Rename</button>
          ${list.length < 2 || checkIns ? '' : `<button class="btn btn-secondary btn-small btn-danger" type="button" data-remove="${escapeHtml(a.id)}"${a.activa ? ' data-was-active' : ''}>Delete</button>`}
        </div>
      </div>`;
    }).join('');
    const add = list.length >= 10 ? '' : `<div class="invite-form act-add">
        <div class="field">
          <label for="${container.id}-new">Add another activity</label>
          <input class="input" id="${container.id}-new" maxlength="60" autocomplete="off" placeholder="e.g. Conversation Club" data-add-input>
        </div>
        <button class="btn btn-secondary btn-small" type="button" data-add="${teacher.id}">＋ Add activity</button>
      </div>`;
    container.innerHTML = rows + add;
  }

  function refreshActivityManagers() {
    if (state.isTeacher && !state.isAdmin) renderActivityManager($('mine-activities'), state.me);
    if (editing && !$('teacher-modal').hidden) renderActivityManager($('tm-activity-manager'), editing);
  }

  function bindActivityManager(container, errorId) {
    container.addEventListener('click', async (e) => {
      const button = e.target.closest('button');
      if (!button) return;
      const d = button.dataset;
      if (d.rename) {
        state.renaming = d.rename;
        refreshActivityManagers();
        const input = container.querySelector('[data-rename-input]');
        if (input) { input.focus(); input.select(); }
        return;
      }
      if ('renameCancel' in d) {
        state.renaming = null;
        return refreshActivityManagers();
      }

      let call;
      if (d.activate) {
        call = db.rpc.bind(db, 'actividad_activar', { p_actividad: d.activate });
      } else if (d.renameSave) {
        const name = container.querySelector('[data-rename-input]').value.trim().replace(/\s+/g, ' ');
        if (name.length < 2) return setAlert(errorId, 'Please write the name of the activity.');
        call = db.rpc.bind(db, 'actividad_renombrar', { p_actividad: d.renameSave, p_nombre: name });
      } else if (d.remove) {
        if (!armed(button, 'wasActive' in d ? 'Tap again: the next one becomes active' : 'Tap again to delete')) return;
        call = db.rpc.bind(db, 'actividad_eliminar', { p_actividad: d.remove });
      } else if (d.add) {
        const name = container.querySelector('[data-add-input]').value.trim().replace(/\s+/g, ' ');
        if (name.length < 2) return setAlert(errorId, 'Please write the name of the new activity.');
        call = db.rpc.bind(db, 'actividad_agregar', { p_profesor: Number(d.add), p_nombre: name });
      } else {
        return;
      }

      button.disabled = true;
      const { error } = await call();
      if (error) {
        button.disabled = false;
        return setAlert(errorId, rpcMessage(error));
      }
      setAlert(errorId, '');
      state.renaming = null;
      await loadData();
    });

    // Enter saves the name instead of submitting the "Edit teacher" form.
    container.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' || e.target.tagName !== 'INPUT') return;
      e.preventDefault();
      const button = e.target.closest('.act-row, .act-add').querySelector('[data-rename-save], [data-add]');
      if (button) button.click();
    });
  }

  // ---------------------------------------------------------------- tabs (administrator)
  function selectTab(tab) {
    state.tab = tab;
    document.querySelectorAll('#admin-tabs .tab').forEach((b) => {
      b.setAttribute('aria-selected', String(b.dataset.tab === tab));
    });
    ['results', 'teachers', 'invites'].forEach((t) => { $(`p-${t}`).hidden = t !== tab; });
  }
  $('admin-tabs').addEventListener('click', (e) => {
    const button = e.target.closest('[data-tab]');
    if (button) selectTab(button.dataset.tab);
  });

  // "Cancel" / "Delete" need a second tap, so nothing is removed by mistake.
  function armed(button, label) {
    if (button.dataset.armed) return true;
    const original = button.textContent;
    button.dataset.armed = '1';
    button.textContent = label;
    setTimeout(() => { delete button.dataset.armed; button.textContent = original; }, 3000);
    return false;
  }

  // ---------------------------------------------------------------- teachers (administrator)
  function checkInsWith(teacher) {
    const ids = new Set(activitiesOf(teacher).map((a) => a.id));
    return state.attendance.filter((a) => ids.has(a.actividad_id)).length;
  }

  function renderTeachers() {
    const list = $('teacher-rows');
    const teachers = state.teachers.filter((t) => !t.es_admin);
    if (!teachers.length) {
      list.innerHTML = '<p class="empty">No teachers yet. Send an invitation link, or add one yourself.</p>';
      return;
    }
    list.innerHTML = teachers.map((t) => {
      const activities = activitiesOf(t);
      const count = state.students.filter((s) => s.profesor_id === t.id).length;
      const checkIns = checkInsWith(t);
      const names = activities.map((a) => (a.activa
        ? `<strong>${escapeHtml(a.nombre)}</strong> <span class="badge badge-done">Active</span>`
        : escapeHtml(a.nombre))).join(' · ');
      const room = (activeActivity(t) || activities[0] || {}).salon;
      return `<div class="invite">
        <div class="invite-head">
          <strong>${escapeHtml(nameOf(t))}</strong>
          <span class="muted" style="font-size:14px">${escapeHtml(t.email)}</span>
        </div>
        <span>${activities.length ? `${activities.length === 1 ? 'Activity' : 'Activities'}: ${names}${room ? ` <span class="muted">– ${escapeHtml(room)}</span>` : ''}` : '<span class="muted">No activities</span>'}</span>
        <span class="muted" style="font-size:14px">${t.grupos} ${t.grupos === 1 ? 'group' : 'groups'} · ${count} ${count === 1 ? 'student' : 'students'} chose this teacher · ${checkIns} check-ins at their activities</span>
        <div class="invite-actions">
          ${activities.length ? `<button class="btn btn-small" type="button" data-see="${t.id}">See results</button>` : ''}
          <button class="btn btn-secondary btn-small" type="button" data-edit="${escapeHtml(t.email)}">Edit</button>
          <a class="btn btn-secondary btn-small" href="qr.html?teacher=${encodeURIComponent(t.id)}" target="_blank" rel="noopener">QR codes</a>
          <button class="btn btn-secondary btn-small btn-danger" type="button" data-delete="${escapeHtml(t.email)}">Delete</button>
        </div>
      </div>`;
    }).join('');
  }

  $('teacher-rows').addEventListener('click', async (e) => {
    const see = e.target.closest('[data-see]');
    if (see) {
      $('f-teacher').value = see.dataset.see;
      fillScope($('f-show'), $('f-show-field'), 'visited');
      selectTab('results');
      render();
      return;
    }
    const edit = e.target.closest('[data-edit]');
    if (edit) return openTeacherModal(state.teachers.find((t) => t.email === edit.dataset.edit));

    const del = e.target.closest('[data-delete]');
    if (!del) return;
    const teacher = state.teachers.find((t) => t.email === del.dataset.delete);
    const checkIns = checkInsWith(teacher);
    if (!armed(del, checkIns ? `Tap again: deletes ${checkIns} check-ins too` : 'Tap again to delete')) return;
    del.disabled = true;
    const { error } = await db.rpc('admin_eliminar_profesor', { p_email: teacher.email });
    if (error) {
      del.disabled = false;
      return setAlert('teachers-error', friendlyError(error));
    }
    setAlert('teachers-error', '');
    loadData();
  });

  // Add (new account) or edit (name, classroom, groups, activities).
  let editing = null;
  const newActivities = activityInputs($('tm-activities'), $('tm-add-activity'), 'tm-activity');

  function openTeacherModal(teacher) {
    editing = teacher || null;
    state.renaming = null;
    const activities = teacher ? activitiesOf(teacher) : [];
    const room = (teacher && (activeActivity(teacher) || activities[0])) || null;
    $('teacher-title').textContent = teacher ? 'Edit teacher' : 'Add teacher';
    $('teacher-desc').textContent = teacher
      ? 'The QR codes keep working after you change these details.'
      : 'Creates the teacher\'s account and their activities. Then send them their email and password.';
    $('tm-name').value = teacher ? teacher.nombre || '' : '';
    $('tm-email').value = teacher ? teacher.email : '';
    $('tm-email').disabled = !!teacher;
    newActivities.reset();
    $('tm-new-activities').hidden = !!teacher;
    $('tm-room').value = room ? room.salon : '';
    fillGroupCount($('tm-groups'), teacher ? teacher.grupos : 1);
    $('tm-manage').hidden = !teacher;
    if (teacher) renderActivityManager($('tm-activity-manager'), teacher);
    $('tm-password').value = '';
    $('tm-password-field').hidden = !!teacher;
    $('tm-reset').hidden = !teacher;
    $('tm-reset-box').hidden = true;
    $('tm-reset-btn').disabled = false;
    $('tm-reset-btn').textContent = '🔑 Create password-change link';
    setAlert('tm-error', '');
    $('teacher-modal').hidden = false;
    $('tm-name').focus();
  }

  function closeTeacherModal() {
    if ($('tm-submit').disabled) return;
    $('teacher-modal').hidden = true;
    state.renaming = null;
  }

  // Single-use link for the teacher to choose a new password.
  $('tm-reset-btn').addEventListener('click', async () => {
    const button = $('tm-reset-btn');
    button.disabled = true;
    const { data, error } = await db.rpc('admin_link_contrasena', { p_email: editing.email });
    button.disabled = false;
    if (error) return setAlert('tm-error', friendlyError(error));
    setAlert('tm-error', '');
    const link = `${cfg.SITE_URL}reset-password.html?code=${encodeURIComponent(data)}`;
    const message = `Hi ${editing.nombre || ''}! Use this link to choose a new password for the ${cfg.EVENT_TITLE} dashboard (it works once, for 48 hours): ${link}`;
    $('tm-reset-link').textContent = link;
    $('tm-reset-copy').dataset.link = link;
    $('tm-reset-wa').href = `https://wa.me/?text=${encodeURIComponent(message)}`;
    $('tm-reset-box').hidden = false;
    button.textContent = '🔑 Create another link';
  });

  $('tm-reset-copy').addEventListener('click', async () => {
    await copyText($('tm-reset-copy').dataset.link);
    $('tm-reset-copy').textContent = 'Copied ✓';
    setTimeout(() => { $('tm-reset-copy').textContent = 'Copy link'; }, 2000);
  });

  $('btn-add-teacher').addEventListener('click', () => openTeacherModal(null));
  $('tm-cancel').addEventListener('click', closeTeacherModal);
  $('teacher-modal').addEventListener('click', (e) => { if (e.target.id === 'teacher-modal') closeTeacherModal(); });

  const RPC_MESSAGES = {
    invalid_name: 'Please write the full name.',
    invalid_activity: 'Please write the name of each activity (2 to 60 characters).',
    invalid_room: 'The classroom name is too long.',
    invalid_groups: 'Please choose the number of groups.',
    groups_in_use: 'Some students already chose a higher group number. Choose more groups.',
    too_many_activities: 'A teacher can have up to 10 activities.',
    last_activity: 'A teacher needs at least one activity.',
    has_checkins: 'This activity already has check-ins, so it can\'t be deleted.',
    already_teacher: 'This email is already registered as a teacher.',
    not_allowed: 'You don\'t have permission to do this.',
  };
  function rpcMessage(error) {
    const key = Object.keys(RPC_MESSAGES).find((k) => (error.message || '').includes(k));
    return key ? RPC_MESSAGES[key] : friendlyError(error);
  }

  // A new account is created with a separate client, so the administrator stays signed in.
  async function createTeacher(nombre, email, actividades, salon, grupos, password) {
    const invite = await db.rpc('crear_invitacion', { p_nota: `Added by the administrator: ${nombre}` });
    if (invite.error) throw invite.error;
    const temp = createDb({ auth: { persistSession: false, autoRefreshToken: false, storageKey: 'rotation-new-teacher' } });
    const up = await temp.auth.signUp({ email, password });
    if (up.error) {
      await db.rpc('anular_invitacion', { p_codigo: invite.data.codigo });
      if (up.error.code === 'user_already_exists' || /already registered/i.test(up.error.message)) {
        return 'This email already has an account.';
      }
      if (up.error.code === 'weak_password') return 'Please choose a stronger password (at least 8 characters).';
      if (/signup|signups/i.test(up.error.message)) return 'Sign-ups are turned off in Supabase (Authentication settings).';
      return friendlyError(up.error);
    }
    if (!up.data.session) return 'The account needs email confirmation. Turn off "Confirm email" in Supabase.';
    const reg = await temp.rpc('registrar_profesor', {
      p_codigo: invite.data.codigo, p_nombre: nombre, p_actividades: actividades, p_salon: salon, p_grupos: grupos,
    });
    await temp.auth.signOut({ scope: 'local' });
    if (!reg.error) return '';
    await db.rpc('anular_invitacion', { p_codigo: invite.data.codigo });
    return rpcMessage(reg.error);
  }

  $('teacher-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const nombre = $('tm-name').value.trim().replace(/\s+/g, ' ');
    const email = $('tm-email').value.trim().toLowerCase();
    const actividades = newActivities.values();
    const salon = $('tm-room').value.trim().replace(/\s+/g, ' ');
    const grupos = Number($('tm-groups').value);
    const password = $('tm-password').value;

    if (nombre.length < 3) return setAlert('tm-error', 'Please write the full name.');
    if (!editing && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return setAlert('tm-error', 'Please check the email address.');
    if (!editing && !actividades.length) return setAlert('tm-error', 'Please write the name of the activity.');
    if (!editing && actividades.some((a) => a.length < 2)) return setAlert('tm-error', 'Each activity name needs at least 2 characters.');
    if (!editing && password.length < 8) return setAlert('tm-error', 'The password must have at least 8 characters.');

    const submit = $('tm-submit');
    submit.disabled = true;
    $('tm-cancel').disabled = true;
    try {
      let message = '';
      if (editing) {
        const { error } = await db.rpc('admin_editar_profesor', {
          p_email: editing.email, p_nombre: nombre, p_salon: salon, p_grupos: grupos,
        });
        if (error) message = rpcMessage(error);
      } else {
        message = await createTeacher(nombre, email, actividades, salon, grupos, password);
      }
      if (message) return setAlert('tm-error', message);
      submit.disabled = false;
      $('tm-cancel').disabled = false;
      closeTeacherModal();
      loadData();
    } catch (err) {
      console.error(err);
      setAlert('tm-error', friendlyError(err));
    } finally {
      submit.disabled = false;
      $('tm-cancel').disabled = false;
    }
  });

  bindActivityManager($('mine-activities'), 'mine-error');
  bindActivityManager($('tm-activity-manager'), 'tm-error');

  // ---------------------------------------------------------------- invitation links (administrator)
  function inviteLink(code) {
    return `${cfg.SITE_URL}teacher-signup.html?code=${encodeURIComponent(code)}`;
  }

  function renderInvites() {
    const list = $('invite-rows');
    if (!state.invites.length) {
      list.innerHTML = '<p class="empty">No invitation links yet.</p>';
      return;
    }
    list.innerHTML = state.invites.map((inv) => {
      const link = inviteLink(inv.codigo);
      const used = !!inv.usada_en;
      const message = `Hi! Create your teacher account for the ${cfg.EVENT_TITLE} here (this link works only once): ${link}`;
      return `<div class="invite ${inv.codigo === state.newInvite ? 'is-new' : ''}">
        <div class="invite-head">
          <strong>${inv.nota ? escapeHtml(inv.nota) : `<span class="muted">Link created ${formatDate(inv.creada_en)}</span>`}</strong>
          ${used ? '<span class="badge badge-done">Used</span>' : '<span class="badge badge-pending">Waiting</span>'}
        </div>
        ${used
          ? `<span class="muted" style="font-size:14px">Account created by ${escapeHtml(inv.usada_por)} · ${formatDate(inv.usada_en)}, ${formatTime(inv.usada_en)}</span>`
          : `<span class="invite-link">${escapeHtml(link)}</span>
            <div class="invite-actions">
              <button class="btn btn-small" type="button" data-copy="${escapeHtml(link)}">Copy link</button>
              <a class="btn btn-secondary btn-small" href="https://wa.me/?text=${encodeURIComponent(message)}" target="_blank" rel="noopener">Send by WhatsApp</a>
              <button class="btn btn-secondary btn-small" type="button" data-cancel="${escapeHtml(inv.codigo)}">Cancel</button>
            </div>`}
      </div>`;
    }).join('');
  }

  $('invite-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const button = e.target.querySelector('button');
    button.disabled = true;
    const { data, error } = await db.rpc('crear_invitacion', { p_nota: $('invite-note').value });
    button.disabled = false;
    if (error) return setAlert('invite-error', friendlyError(error));
    setAlert('invite-error', '');
    $('invite-note').value = '';
    state.newInvite = data.codigo;
    state.invites.unshift(data);
    renderInvites();
  });

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const input = document.createElement('textarea');
      input.value = text;
      document.body.appendChild(input);
      input.select();
      document.execCommand('copy');
      input.remove();
    }
  }

  $('invite-rows').addEventListener('click', async (e) => {
    const copy = e.target.closest('[data-copy]');
    if (copy) {
      await copyText(copy.dataset.copy);
      copy.textContent = 'Copied ✓';
      setTimeout(() => { copy.textContent = 'Copy link'; }, 2000);
      return;
    }
    const cancel = e.target.closest('[data-cancel]');
    if (!cancel || !armed(cancel, 'Tap again to cancel')) return;
    cancel.disabled = true;
    const { error } = await db.rpc('anular_invitacion', { p_codigo: cancel.dataset.cancel });
    if (error) return setAlert('invite-error', friendlyError(error));
    state.invites = state.invites.filter((inv) => inv.codigo !== cancel.dataset.cancel);
    renderInvites();
  });

  // ---------------------------------------------------------------- delete a student (administrator)
  $('students-rows').addEventListener('click', async (e) => {
    const button = e.target.closest('[data-delete-student]');
    if (!button || !armed(button, 'Tap again to delete')) return;
    const code = button.dataset.deleteStudent;
    const photos = state.attendance.filter((a) => a.estudiante_codigo === code).map((a) => a.foto_path);
    button.disabled = true;
    const { error } = await db.rpc('admin_eliminar_estudiante', { p_codigo: code });
    if (error) {
      button.disabled = false;
      return setAlert('dash-error', friendlyError(error));
    }
    if (photos.length) {
      const removed = await db.storage.from('evidencias').remove(photos);
      if (removed.error) console.error(removed.error);
    }
    setAlert('dash-error', '');
    loadData();
  });

  // ---------------------------------------------------------------- lightbox
  $('students-rows').addEventListener('click', async (e) => {
    const button = e.target.closest('button.thumb');
    if (!button) return;
    const path = button.dataset.path;
    const record = state.attendance.find((a) => a.foto_path === path);
    const student = state.students.find((s) => s.codigo === record.estudiante_codigo);
    const activity = activityById(record.actividad_id);
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
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (!$('lightbox').hidden) closeLightbox();
    else if (!$('teacher-modal').hidden) closeTeacherModal();
  });

  // ---------------------------------------------------------------- PDF report
  const C = {
    green: [9, 132, 59], greenDark: [4, 106, 56], greenSoft: [231, 244, 235],
    goldSoft: [255, 245, 212], goldText: [122, 93, 0], ocre: [239, 219, 178],
    bgAlt: [245, 245, 240], text: [31, 42, 36], text2: [91, 102, 96],
    border: [218, 221, 216], rowAlt: [250, 250, 247], faint: [170, 175, 170],
  };
  // Letter, landscape: one column per teacher.
  const PAGE = { w: 792, h: 612, m: 36, top: 88, bottom: 52 };
  const THUMB = 34;

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = src;
      script.onload = resolve;
      script.onerror = () => reject(new Error('Failed to fetch the PDF library'));
      document.head.appendChild(script);
    });
  }

  async function loadPdfLibs() {
    if (!window.jspdf) await loadScript(PDF_LIBS[0]);
    if (!window.jspdf.jsPDF.API.autoTable) await loadScript(PDF_LIBS[1]);
  }

  function blobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  }

  function blobToImage(blob) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(blob);
      const img = new Image();
      img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('image_load_failed')); };
      img.src = url;
    });
  }

  // Square, small JPEG so the PDF stays light.
  async function thumbnail(url, size = 100) {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`photo ${response.status}`);
    const img = await blobToImage(await response.blob());
    const side = Math.min(img.naturalWidth, img.naturalHeight);
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    canvas.getContext('2d').drawImage(img,
      (img.naturalWidth - side) / 2, (img.naturalHeight - side) / 2, side, side, 0, 0, size, size);
    return canvas.toDataURL('image/jpeg', 0.75);
  }

  async function makeThumbnails(records, onProgress) {
    const urls = new Map();
    const paths = [...new Set(records.map((r) => r.foto_path))];
    for (let i = 0; i < paths.length; i += 200) {
      const { data, error } = await db.storage.from('evidencias').createSignedUrls(paths.slice(i, i + 200), 600);
      if (error) throw error;
      data.forEach((d) => { if (d.signedUrl) urls.set(d.path, d.signedUrl); });
    }

    const thumbs = new Map();
    const queue = [...paths];
    let done = 0;
    async function worker() {
      while (queue.length) {
        const path = queue.shift();
        try {
          if (urls.has(path)) thumbs.set(path, await thumbnail(urls.get(path)));
        } catch (err) {
          console.error(err);
        }
        onProgress(++done, paths.length);
      }
    }
    await Promise.all(Array.from({ length: 6 }, worker));
    return thumbs;
  }

  // The built-in PDF fonts only cover Western European characters.
  function pdfText(value) {
    return String(value ?? '')
      .replace(/[–—]/g, '-')
      .replace(/[‘’]/g, "'")
      .replace(/[“”]/g, '"')
      .replace(/[^\x00-\xFF]/g, '');
  }

  function tableOptions(extra) {
    return {
      theme: 'grid',
      margin: { top: PAGE.top, bottom: PAGE.bottom, left: PAGE.m, right: PAGE.m },
      styles: {
        font: 'helvetica', fontSize: 9, textColor: C.text, lineColor: C.border, lineWidth: 0.5,
        cellPadding: 5, valign: 'middle', overflow: 'linebreak',
      },
      headStyles: { fillColor: C.ocre, textColor: C.text, fontStyle: 'bold', fontSize: 8 },
      alternateRowStyles: { fillColor: C.rowAlt },
      ...extra,
    };
  }

  function ensureSpace(doc, y, needed) {
    if (y + needed > PAGE.h - PAGE.bottom) {
      doc.addPage();
      return PAGE.top;
    }
    return y;
  }

  function titleBlock(doc, y, kicker, heading, details) {
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(9);
    doc.setTextColor(...C.green);
    doc.text(pdfText(kicker.toUpperCase()), PAGE.m, y + 8);
    doc.setFont('times', 'bold');
    doc.setFontSize(24);
    doc.setTextColor(...C.text);
    doc.text(pdfText(heading), PAGE.m, y + 34);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(10);
    doc.setTextColor(...C.text2);
    let line = y + 52;
    details.forEach((d) => { doc.text(pdfText(d), PAGE.m, line); line += 14; });
    return line + 6;
  }

  function sectionHeading(doc, y, text, note) {
    y = ensureSpace(doc, y, 90);
    doc.setFont('times', 'bold');
    doc.setFontSize(15);
    doc.setTextColor(...C.text);
    doc.text(pdfText(text), PAGE.m, y + 12);
    if (note) {
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(9);
      doc.setTextColor(...C.text2);
      doc.text(pdfText(note), PAGE.w - PAGE.m, y + 12, { align: 'right' });
    }
    doc.setDrawColor(...C.green);
    doc.setLineWidth(1.5);
    doc.line(PAGE.m, y + 19, PAGE.m + 36, y + 19);
    return y + 30;
  }

  function emptyNote(doc, y, text) {
    doc.setFont('helvetica', 'italic');
    doc.setFontSize(10);
    doc.setTextColor(...C.text2);
    doc.text(pdfText(text), PAGE.m, y + 10);
    return y + 26;
  }

  function statBoxes(doc, y, stats) {
    const gap = 10;
    const width = (PAGE.w - PAGE.m * 2 - gap * (stats.length - 1)) / stats.length;
    stats.forEach(([num, label], i) => {
      const x = PAGE.m + i * (width + gap);
      doc.setFillColor(...C.bgAlt);
      doc.roundedRect(x, y, width, 50, 4, 4, 'F');
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(18);
      doc.setTextColor(...C.green);
      doc.text(String(num), x + 10, y + 24);
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(8);
      doc.setTextColor(...C.text2);
      doc.text(pdfText(label), x + 10, y + 39);
    });
    return y + 66;
  }

  // One row per student; one column per teacher with the photo, activity and time.
  function progressTable(doc, y, v, thumbs) {
    if (!v.students.length) return emptyNote(doc, y, 'No students in this list yet.');
    const { showTeacher, showGroup } = extraColumns(v);
    const columns = [{ head: '#', kind: 'num', value: (s, i) => String(i + 1) }];
    columns.push({ head: 'Student', kind: 'name', value: (s) => s.nombre });
    columns.push({ head: 'ID', kind: 'id', value: (s) => s.codigo });
    if (showTeacher) {
      columns.push({ head: 'Teacher', kind: 'teacher', value: (s) => [teacherOf(s), groupOf(s)].filter(Boolean).join('\n') });
    }
    if (showGroup) columns.push({ head: 'Group', kind: 'group', value: (s) => groupOf(s) });
    v.columns.forEach((t) => {
      columns.push({ head: nameOf(t), kind: 'station', teacher: t, value: (s) => {
        const r = recordOf(s, t);
        if (!r) return 'Pending';
        const activity = activityById(r.actividad_id);
        return `${activity ? activity.nombre : ''}\n${formatTime(r.registrado_en)}`;
      } });
    });
    columns.push({ head: 'Done', kind: 'done', value: (s) => `${completedCount(s)}/${state.stations.length}` });
    columns.push({ head: 'Status', kind: 'status', value: (s) => (isComplete(s) ? 'Complete' : 'Incomplete') });

    const fixed = 20 + 110 + 46 + (showTeacher ? 90 : 0) + (showGroup ? 44 : 0) + 34 + 60;
    const stationWidth = Math.max(44, Math.min(90, (PAGE.w - PAGE.m * 2 - fixed) / Math.max(1, v.columns.length)));
    const columnStyles = {};
    columns.forEach((c, i) => {
      if (c.kind === 'num') columnStyles[i] = { cellWidth: 20, halign: 'center', textColor: C.text2 };
      if (c.kind === 'name') columnStyles[i] = { fontStyle: 'bold' };
      if (c.kind === 'id') columnStyles[i] = { cellWidth: 46 };
      if (c.kind === 'teacher') columnStyles[i] = { cellWidth: 90 };
      if (c.kind === 'group') columnStyles[i] = { cellWidth: 44 };
      if (c.kind === 'station') columnStyles[i] = { cellWidth: stationWidth, halign: 'center', fontSize: 7 };
      if (c.kind === 'done') columnStyles[i] = { cellWidth: 34, halign: 'center' };
      if (c.kind === 'status') columnStyles[i] = { cellWidth: 60, halign: 'center' };
    });
    const photoOf = (row, column) => {
      const r = recordOf(v.students[row], column.teacher);
      return r && thumbs && thumbs.get(r.foto_path);
    };

    doc.autoTable(tableOptions({
      startY: y,
      head: [columns.map((c) => pdfText(c.head))],
      body: v.students.map((s, i) => columns.map((c) => pdfText(c.value(s, i)))),
      styles: {
        font: 'helvetica', fontSize: 8, textColor: C.text, lineColor: C.border, lineWidth: 0.5,
        cellPadding: 4, valign: 'middle', overflow: 'linebreak',
      },
      headStyles: { fillColor: C.ocre, textColor: C.text, fontStyle: 'bold', fontSize: 7, halign: 'center' },
      columnStyles,
      didParseCell: (data) => {
        const column = columns[data.column.index];
        if (data.section === 'head') {
          if (column.teacher && column.teacher === v.focus) {
            data.cell.styles.fillColor = C.green;
            data.cell.styles.textColor = [255, 255, 255];
          }
          return;
        }
        if (column.kind === 'station') {
          const done = data.cell.raw !== 'Pending';
          data.cell.styles.textColor = done ? C.green : C.faint;
          if (column.teacher === v.focus) data.cell.styles.fillColor = C.greenSoft;
          // Room for the photo above the text.
          if (photoOf(data.row.index, column)) {
            data.cell.styles.cellPadding = { top: THUMB + 8, right: 3, bottom: 4, left: 3 };
          }
        } else if (column.kind === 'status') {
          const complete = data.cell.raw === 'Complete';
          data.cell.styles.fillColor = complete ? C.greenSoft : C.goldSoft;
          data.cell.styles.textColor = complete ? C.greenDark : C.goldText;
          data.cell.styles.fontStyle = 'bold';
        }
      },
      didDrawCell: (data) => {
        const column = columns[data.column.index];
        if (data.section !== 'body' || column.kind !== 'station') return;
        const img = photoOf(data.row.index, column);
        if (img) doc.addImage(img, 'JPEG', data.cell.x + (data.cell.width - THUMB) / 2, data.cell.y + 4, THUMB, THUMB);
      },
    }));
    return doc.lastAutoTable.finalY + 22;
  }

  // Logo, title and green rule on top; institution and page numbers at the bottom.
  function decoratePages(doc, logo, generatedAt) {
    const pages = doc.getNumberOfPages();
    for (let i = 1; i <= pages; i++) {
      doc.setPage(i);
      if (logo) doc.addImage(logo, 'PNG', PAGE.m, 22, 172, 28);
      doc.setFont('times', 'bold');
      doc.setFontSize(13);
      doc.setTextColor(...C.text);
      doc.text(pdfText(cfg.EVENT_TITLE), PAGE.w - PAGE.m, 35, { align: 'right' });
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(8.5);
      doc.setTextColor(...C.text2);
      doc.text('Attendance report', PAGE.w - PAGE.m, 48, { align: 'right' });
      doc.setDrawColor(...C.green);
      doc.setLineWidth(3);
      doc.line(PAGE.m, 62, PAGE.w - PAGE.m, 62);

      doc.setDrawColor(...C.border);
      doc.setLineWidth(0.5);
      doc.line(PAGE.m, PAGE.h - 38, PAGE.w - PAGE.m, PAGE.h - 38);
      doc.setFontSize(8);
      doc.setTextColor(...C.text2);
      doc.text(pdfText(cfg.FOOTER), PAGE.m, PAGE.h - 24);
      doc.text(pdfText(`Generated ${generatedAt}  |  Page ${i} of ${pages}`), PAGE.w - PAGE.m, PAGE.h - 24, { align: 'right' });
    }
  }

  function buildReport(doc, v, thumbs) {
    const n = v.students.length;
    const details = [];
    if (v.teacher) {
      const activities = activitiesOf(v.teacher).map((a) => `${a.nombre}${a.activa ? ' (active)' : ''}`);
      details.push(`${activities.length === 1 ? 'Activity' : 'Activities'}: ${activities.join(', ')}`);
      details.push(`${scopeLabel(v)}: ${n} ${n === 1 ? 'student' : 'students'}`);
    } else {
      details.push(`${state.stations.length} teachers  |  ${n} students registered`);
    }

    let y = titleBlock(doc, PAGE.top, v.teacher ? 'Attendance report · Teacher' : 'Attendance report',
      v.teacher ? nameOf(v.teacher) : 'All teachers', details);
    y = statBoxes(doc, y, summary(v));
    y = sectionHeading(doc, y, "Students' progress", 'For each teacher: the activity the student did and the check-in time');
    progressTable(doc, y, v, thumbs);
  }

  function fileSafe(text) {
    return pdfText(text).normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '');
  }

  // Dialog
  function describePdf() {
    const v = currentView($('pdf-scope').value);
    const n = v.students.length;
    $('pdf-desc').textContent = `${scopeLabel(v)} (${n} ${n === 1 ? 'student' : 'students'}), with the activity they did with each teacher and whether they finished.`;
  }

  function openPdfDialog() {
    fillScope($('pdf-scope'), $('pdf-scope-field'), $('f-show').value);
    describePdf();
    setAlert('pdf-error', '');
    $('pdf-status').textContent = '';
    $('pdf-modal').hidden = false;
  }
  $('pdf-scope').addEventListener('change', describePdf);

  function closePdfDialog() {
    if ($('pdf-submit').disabled) return;
    $('pdf-modal').hidden = true;
  }

  $('btn-download').addEventListener('click', openPdfDialog);
  $('pdf-cancel').addEventListener('click', closePdfDialog);
  $('pdf-modal').addEventListener('click', (e) => { if (e.target.id === 'pdf-modal') closePdfDialog(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('pdf-modal').hidden) closePdfDialog(); });

  $('pdf-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const v = currentView($('pdf-scope').value);
    const submit = $('pdf-submit');
    submit.disabled = true;
    $('pdf-cancel').disabled = true;
    setAlert('pdf-error', '');
    try {
      $('pdf-status').textContent = 'Preparing the report…';
      await loadPdfLibs();

      const logoBlob = await fetch('unisimon-logo-50-year.png').then((r) => r.blob());
      const logo = await blobToDataUrl(logoBlob);

      let thumbs = null;
      if ($('pdf-photos').checked) {
        const records = v.students.flatMap((s) => v.columns.map((t) => recordOf(s, t))).filter(Boolean);
        thumbs = await makeThumbnails(records, (done, total) => {
          $('pdf-status').textContent = `Adding photos… ${done} of ${total}`;
        });
      }

      $('pdf-status').textContent = 'Creating the PDF…';
      const doc = new window.jspdf.jsPDF({ unit: 'pt', format: 'letter', orientation: 'landscape' });
      doc.setProperties({ title: `${cfg.EVENT_TITLE} - Attendance report`, author: cfg.FOOTER });
      buildReport(doc, v, thumbs);

      const now = new Date();
      decoratePages(doc, logo, `${formatDate(now)}, ${formatTime(now)}`);
      const day = formatDateTimePlain(now).slice(0, 10);
      const suffix = { visited: 'activity', mine: 'students' }[v.scope] || v.scope.replace('g', 'group-');
      const who = v.teacher ? `${fileSafe(nameOf(v.teacher))}-${suffix}` : 'All-teachers';
      doc.save(`${fileSafe(cfg.EVENT_TITLE)}-${who}-${day}.pdf`);

      $('pdf-status').textContent = '';
      submit.disabled = false;
      $('pdf-cancel').disabled = false;
      closePdfDialog();
    } catch (err) {
      console.error(err);
      setAlert('pdf-error', friendlyError(err));
      $('pdf-status').textContent = '';
    } finally {
      submit.disabled = false;
      $('pdf-cancel').disabled = false;
    }
  });

  start();
})();
