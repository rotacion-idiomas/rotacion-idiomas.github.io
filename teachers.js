// Dashboard. A teacher sees the students who chose them; the administrator
// sees everyone (with filters) and manages teachers and invitation links.
(function () {
  const { createDb, formatDate, formatTime, formatDateTimePlain, escapeHtml, friendlyError,
    fillBranding, cfg } = window.App;

  const db = createDb();
  const PDF_LIBS = [
    'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js',
    'https://cdnjs.cloudflare.com/ajax/libs/jspdf-autotable/3.8.2/jspdf.plugin.autotable.min.js',
  ];
  const PAGE_SIZE = 1000;

  const state = {
    activities: [],
    students: [],           // every student the account can see
    attendance: [],
    byStudent: new Map(),   // codigo -> Map(actividad_id -> attendance)
    photoUrls: new Map(),   // foto_path -> signed URL
    email: '',
    myActivity: null,       // activity of the signed-in teacher
    isTeacher: false,       // accounts not in 'profesores' can't see students
    isAdmin: false,
    teachers: [],           // administrator: rows of 'profesores'
    invites: [],
    newInvite: null,
    tab: 'results',
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
      const [activities, students, attendance, mine] = await Promise.all([
        fetchAll('actividades', 'id, nombre, salon, profesor, orden', 'orden'),
        fetchAll('estudiantes', 'codigo, nombre, profesor_actividad, creado_en', 'codigo'),
        fetchAll('asistencias', 'id, estudiante_codigo, actividad_id, registrado_en, foto_path', 'id'),
        db.from('profesores').select('actividad_id, es_admin').eq('email', state.email).maybeSingle(),
      ]);
      if (mine.error) throw mine.error;
      state.activities = activities;
      state.isTeacher = !!mine.data;
      state.isAdmin = !!(mine.data && mine.data.es_admin);
      state.myActivity = state.isAdmin ? null : activityById(mine.data && mine.data.actividad_id);

      state.students = students.sort((a, b) => a.nombre.localeCompare(b.nombre, 'es'));
      state.attendance = attendance;
      state.byStudent = new Map(students.map((s) => [s.codigo, new Map()]));
      attendance.forEach((a) => {
        if (state.byStudent.has(a.estudiante_codigo)) state.byStudent.get(a.estudiante_codigo).set(a.actividad_id, a);
      });

      if (state.isAdmin) {
        const [teachers, invites] = await Promise.all([
          db.from('profesores').select('email, nombre, actividad_id, es_admin, creado_en').order('creado_en'),
          db.from('invitaciones').select('*').order('creada_en', { ascending: false }),
        ]);
        if (teachers.error) throw teachers.error;
        if (invites.error) throw invites.error;
        state.teachers = teachers.data.filter((t) => !t.es_admin);
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
  // teacher: whose students; focus: activity shown first, with photos.
  function currentView() {
    const teacher = state.isAdmin ? activityById($('f-teacher').value) : state.myActivity;
    const focus = state.isAdmin ? activityById($('f-activity').value) : state.myActivity;
    const students = teacher
      ? state.students.filter((s) => s.profesor_actividad === teacher.id)
      : state.students;
    return { teacher, focus, students, others: state.activities.filter((a) => a !== focus) };
  }

  function recordOf(student, activity) {
    const done = state.byStudent.get(student.codigo);
    return (done && done.get(activity.id)) || null;
  }

  function completedCount(student) {
    return state.activities.filter((a) => recordOf(student, a)).length;
  }

  function isComplete(student) {
    return state.activities.length > 0 && completedCount(student) >= state.activities.length;
  }

  function teacherOf(student) {
    const activity = activityById(student.profesor_actividad);
    return activity ? activity.profesor : '';
  }

  function matches(student, query) {
    if (!query) return true;
    const q = query.toLowerCase();
    return student.nombre.toLowerCase().includes(q) || student.codigo.toLowerCase().includes(q);
  }

  function summary(v) {
    const finished = v.students.filter(isComplete).length;
    const checkIns = v.focus
      ? [v.students.filter((s) => recordOf(s, v.focus)).length, `Checked in at ${v.focus.nombre}`]
      : [v.students.reduce((n, s) => n + completedCount(s), 0), 'Total check-ins'];
    return [
      [v.students.length, state.isAdmin || !v.teacher ? 'Students' : 'My students'],
      checkIns,
      [finished, 'Completed all activities'],
      [v.students.length - finished, 'Still in progress'],
    ];
  }

  function withRoom(activity) {
    return `${activity.nombre}${activity.salon ? ` – ${activity.salon}` : ''}`;
  }

  // ---------------------------------------------------------------- rendering
  function renderHeader() {
    const mine = state.myActivity;
    $('dash-role').textContent = state.isAdmin ? 'Administrator' : 'My students';
    $('admin-tabs').hidden = !state.isAdmin;
    document.querySelectorAll('[data-admin-only]').forEach((el) => { el.hidden = !state.isAdmin; });
    let info;
    if (state.isAdmin) info = 'You can see every teacher\'s results and manage the teachers.';
    else if (mine) info = `<strong>${escapeHtml(mine.profesor)}</strong> · Your activity: ${escapeHtml(withRoom(mine))}`;
    else if (state.isTeacher) info = 'Your account isn\'t linked to an activity, so you can see <strong>every student</strong>.';
    else info = 'This account isn\'t registered as a teacher. Please create your account with the sign-up link you received.';
    $('teacher-info').innerHTML = info;
    selectTab(state.isAdmin ? state.tab : 'results');
  }

  function fillFilters() {
    if (!state.isAdmin) return;
    const teacher = $('f-teacher');
    const activity = $('f-activity');
    const [t, a] = [teacher.value, activity.value];
    const byTeacher = [...state.activities].sort((x, y) => x.profesor.localeCompare(y.profesor, 'es'));
    teacher.innerHTML = '<option value="">All teachers</option>' + byTeacher.map((x) =>
      `<option value="${escapeHtml(x.id)}">${escapeHtml(x.profesor)}</option>`).join('');
    activity.innerHTML = '<option value="">No photos (all activities)</option>' + state.activities.map((x) =>
      `<option value="${escapeHtml(x.id)}">${escapeHtml(withRoom(x))}</option>`).join('');
    teacher.value = activityById(t) ? t : '';
    activity.value = activityById(a) ? a : '';
  }

  function render() {
    $('stats').innerHTML = summary(currentView()).map(([num, label]) =>
      `<div class="stat"><div class="num">${num}</div><div class="label">${escapeHtml(label)}</div></div>`).join('');
    renderTable();
    if (state.isAdmin) {
      renderTeachers();
      renderInvites();
    }
  }

  // Choosing a teacher shows their activity's photos, like their own dashboard.
  $('f-teacher').addEventListener('change', () => {
    $('f-activity').value = $('f-teacher').value;
    render();
  });
  $('f-activity').addEventListener('change', render);
  $('search').addEventListener('input', renderTable);
  $('only-incomplete').addEventListener('change', renderTable);

  function checkCell(record) {
    return record
      ? `<td class="c"><span class="yes" title="${escapeHtml(formatDate(record.registrado_en) + ', ' + formatTime(record.registrado_en))}">✓</span></td>`
      : '<td class="c"><span class="no" title="Not yet">✗</span></td>';
  }

  async function renderTable() {
    const v = currentView();
    const total = state.activities.length;
    const showTeacher = !v.teacher;
    const columns = 4 + (showTeacher ? 1 : 0) + (v.focus ? 1 : 0) + v.others.length + (state.isAdmin ? 1 : 0);

    $('students-head').innerHTML = `<tr>
      <th>Student</th><th>Student ID</th>
      ${showTeacher ? '<th>Teacher</th>' : ''}
      ${v.focus ? `<th class="mine">${escapeHtml(v.focus.nombre)} · photo</th>` : ''}
      ${v.others.map((a) => `<th class="c">${escapeHtml(a.nombre)}</th>`).join('')}
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
        empty = v.teacher && !state.isAdmin
          ? 'No students have chosen you as their teacher yet.'
          : (v.teacher ? 'No students have chosen this teacher yet.' : 'No students registered yet.');
      }
      tbody.innerHTML = `<tr><td colspan="${columns}" class="empty">${empty}</td></tr>`;
      return;
    }

    tbody.innerHTML = rows.map((s) => {
      const complete = isComplete(s);
      let focusCell = '';
      if (v.focus) {
        const r = recordOf(s, v.focus);
        focusCell = r
          ? `<td class="mine"><div class="photo-cell">
              <button class="thumb" type="button" data-path="${escapeHtml(r.foto_path)}" aria-label="View photo of ${escapeHtml(s.nombre)}"><img alt="" data-src-path="${escapeHtml(r.foto_path)}"></button>
              <span class="nowrap"><span class="yes">✓</span> ${formatTime(r.registrado_en)}</span>
            </div></td>`
          : '<td class="mine"><span class="no">✗</span> <span class="muted">Not yet</span></td>';
      }
      return `<tr class="${complete ? '' : 'is-incomplete'}">
        <td><strong>${escapeHtml(s.nombre)}</strong></td>
        <td class="nowrap">${escapeHtml(s.codigo)}</td>
        ${showTeacher ? `<td>${escapeHtml(teacherOf(s)) || '<span class="muted">—</span>'}</td>` : ''}
        ${focusCell}
        ${v.others.map((a) => checkCell(recordOf(s, a))).join('')}
        <td class="c nowrap"><strong>${completedCount(s)}/${total}</strong></td>
        <td>${complete
          ? '<span class="badge badge-done">Complete</span>'
          : '<span class="badge badge-pending">Incomplete</span>'}</td>
        ${state.isAdmin ? `<td><button class="btn btn-secondary btn-small btn-danger" type="button" data-delete-student="${escapeHtml(s.codigo)}">Delete</button></td>` : ''}
      </tr>`;
    }).join('');

    // Only the photos of the activity in focus are loaded.
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
    for (let i = 0; i < missing.length; i += 100) {
      const chunk = missing.slice(i, i + 100);
      const { data, error } = await db.storage.from('evidencias').createSignedUrls(chunk, 3600);
      if (error) { console.error(error); continue; }
      data.forEach((d) => { if (d.signedUrl) state.photoUrls.set(d.path, d.signedUrl); });
    }
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
  function renderTeachers() {
    const list = $('teacher-rows');
    if (!state.teachers.length) {
      list.innerHTML = '<p class="empty">No teachers yet. Send an invitation link, or add one yourself.</p>';
      return;
    }
    list.innerHTML = state.teachers.map((t) => {
      const activity = activityById(t.actividad_id);
      const count = state.students.filter((s) => activity && s.profesor_actividad === activity.id).length;
      const checkIns = activity ? state.attendance.filter((a) => a.actividad_id === activity.id).length : 0;
      return `<div class="invite">
        <div class="invite-head">
          <strong>${escapeHtml(t.nombre || t.email)}</strong>
          <span class="muted" style="font-size:14px">${escapeHtml(t.email)}</span>
        </div>
        <span>${activity ? `Activity: <strong>${escapeHtml(withRoom(activity))}</strong>` : '<span class="muted">No activity</span>'}</span>
        <span class="muted" style="font-size:14px">${count} ${count === 1 ? 'student' : 'students'} chose this teacher · ${checkIns} check-ins at this activity</span>
        <div class="invite-actions">
          ${activity ? `<button class="btn btn-small" type="button" data-see="${escapeHtml(activity.id)}">See results</button>` : ''}
          <button class="btn btn-secondary btn-small" type="button" data-edit="${escapeHtml(t.email)}">Edit</button>
          <a class="btn btn-secondary btn-small" href="qr.html${activity ? `?activity=${encodeURIComponent(activity.id)}` : ''}" target="_blank" rel="noopener">QR code</a>
          <button class="btn btn-secondary btn-small btn-danger" type="button" data-delete="${escapeHtml(t.email)}">Delete</button>
        </div>
      </div>`;
    }).join('');
  }

  $('teacher-rows').addEventListener('click', async (e) => {
    const see = e.target.closest('[data-see]');
    if (see) {
      $('f-teacher').value = see.dataset.see;
      $('f-activity').value = see.dataset.see;
      selectTab('results');
      render();
      return;
    }
    const edit = e.target.closest('[data-edit]');
    if (edit) return openTeacherModal(state.teachers.find((t) => t.email === edit.dataset.edit));

    const del = e.target.closest('[data-delete]');
    if (!del) return;
    const teacher = state.teachers.find((t) => t.email === del.dataset.delete);
    const checkIns = state.attendance.filter((a) => a.actividad_id === teacher.actividad_id).length;
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

  // Add (new account) or edit (name, activity, classroom).
  let editing = null;

  function openTeacherModal(teacher) {
    editing = teacher || null;
    const activity = teacher && activityById(teacher.actividad_id);
    $('teacher-title').textContent = teacher ? 'Edit teacher' : 'Add teacher';
    $('teacher-desc').textContent = teacher
      ? 'The QR code keeps working after you change these details.'
      : 'Creates the teacher\'s account and their activity. Then send them their email and password.';
    $('tm-name').value = teacher ? teacher.nombre || '' : '';
    $('tm-email').value = teacher ? teacher.email : '';
    $('tm-email').disabled = !!teacher;
    $('tm-activity').value = activity ? activity.nombre : '';
    $('tm-room').value = activity ? activity.salon : '';
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
    invalid_activity: 'Please write the name of the activity (2 to 60 characters).',
    invalid_room: 'The classroom name is too long.',
    already_teacher: 'This email is already registered as a teacher.',
    not_allowed: 'Only the administrator can do this.',
  };
  function rpcMessage(error) {
    const key = Object.keys(RPC_MESSAGES).find((k) => (error.message || '').includes(k));
    return key ? RPC_MESSAGES[key] : friendlyError(error);
  }

  // A new account is created with a separate client, so the administrator stays signed in.
  async function createTeacher(nombre, email, actividad, salon, password) {
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
      p_codigo: invite.data.codigo, p_nombre: nombre, p_actividad: actividad, p_salon: salon,
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
    const actividad = $('tm-activity').value.trim().replace(/\s+/g, ' ');
    const salon = $('tm-room').value.trim().replace(/\s+/g, ' ');
    const password = $('tm-password').value;

    if (nombre.length < 3) return setAlert('tm-error', 'Please write the full name.');
    if (!editing && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return setAlert('tm-error', 'Please check the email address.');
    if (actividad.length < 2) return setAlert('tm-error', 'Please write the name of the activity.');
    if (!editing && password.length < 8) return setAlert('tm-error', 'The password must have at least 8 characters.');

    const submit = $('tm-submit');
    submit.disabled = true;
    $('tm-cancel').disabled = true;
    try {
      let message = '';
      if (editing) {
        const { error } = await db.rpc('admin_editar_profesor', {
          p_email: editing.email, p_nombre: nombre, p_actividad: actividad, p_salon: salon,
        });
        if (error) message = rpcMessage(error);
      } else {
        message = await createTeacher(nombre, email, actividad, salon, password);
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
  const PAGE = { w: 612, h: 792, m: 40, top: 92, bottom: 56 };
  const THUMB = 40;

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
  async function thumbnail(url, size = 120) {
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
    for (let i = 0; i < paths.length; i += 100) {
      const { data, error } = await db.storage.from('evidencias').createSignedUrls(paths.slice(i, i + 100), 600);
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

  // One row per student: activity in focus (time + photo), the others (Done/Pending), status.
  function progressTable(doc, y, v, thumbs) {
    if (!v.students.length) {
      return emptyNote(doc, y, v.teacher ? 'No students have chosen this teacher yet.' : 'No students registered yet.');
    }
    const mine = v.focus;
    const columns = [{ head: '#', kind: 'num', value: (s, i) => String(i + 1) }];
    if (thumbs) columns.push({ head: 'Photo', kind: 'photo', value: () => '' });
    columns.push({ head: 'Student', kind: 'name', value: (s) => s.nombre });
    columns.push({ head: 'ID', kind: 'id', value: (s) => s.codigo });
    if (!v.teacher) columns.push({ head: 'Teacher', kind: 'teacher', value: (s) => teacherOf(s) });
    if (mine) {
      columns.push({ head: mine.nombre, kind: 'mine', value: (s) => {
        const r = recordOf(s, mine);
        return r ? formatTime(r.registrado_en) : 'Pending';
      } });
    }
    v.others.forEach((a) => {
      columns.push({ head: a.nombre, kind: 'check', value: (s) => (recordOf(s, a) ? 'Done' : 'Pending') });
    });
    columns.push({ head: 'Status', kind: 'status', value: (s) => (isComplete(s) ? 'Complete' : 'Incomplete') });

    const columnStyles = {};
    columns.forEach((c, i) => {
      if (c.kind === 'num') columnStyles[i] = { cellWidth: 22, halign: 'center', textColor: C.text2 };
      if (c.kind === 'photo') columnStyles[i] = { cellWidth: THUMB + 10 };
      if (c.kind === 'name') columnStyles[i] = { fontStyle: 'bold' };
      if (c.kind === 'id') columnStyles[i] = { cellWidth: 50 };
      if (['mine', 'check', 'status'].includes(c.kind)) columnStyles[i] = { halign: 'center' };
    });
    const photoOf = (row) => {
      const r = mine && recordOf(v.students[row], mine);
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
        const kind = columns[data.column.index].kind;
        if (data.section === 'head') {
          if (kind === 'mine') { data.cell.styles.fillColor = C.green; data.cell.styles.textColor = [255, 255, 255]; }
          return;
        }
        if (kind === 'photo' && photoOf(data.row.index)) data.cell.styles.minCellHeight = THUMB + 8;
        if (kind === 'mine' || kind === 'check') {
          const done = data.cell.raw !== 'Pending';
          data.cell.styles.textColor = done ? C.green : C.faint;
          data.cell.styles.fontStyle = done ? 'bold' : 'normal';
          if (kind === 'mine') data.cell.styles.fillColor = C.greenSoft;
        } else if (kind === 'status') {
          const complete = data.cell.raw === 'Complete';
          data.cell.styles.fillColor = complete ? C.greenSoft : C.goldSoft;
          data.cell.styles.textColor = complete ? C.greenDark : C.goldText;
          data.cell.styles.fontStyle = 'bold';
        }
      },
      didDrawCell: (data) => {
        if (data.section !== 'body' || columns[data.column.index].kind !== 'photo') return;
        const img = photoOf(data.row.index);
        if (img) {
          doc.addImage(img, 'JPEG', data.cell.x + 5, data.cell.y + (data.cell.height - THUMB) / 2, THUMB, THUMB);
        }
      },
    }));
    return doc.lastAutoTable.finalY + 22;
  }

  // Logo, title and green rule on top; institution and page numbers at the bottom.
  function decoratePages(doc, logo, generatedAt) {
    const pages = doc.getNumberOfPages();
    for (let i = 1; i <= pages; i++) {
      doc.setPage(i);
      if (logo) doc.addImage(logo, 'PNG', PAGE.m, 24, 172, 28);
      doc.setFont('times', 'bold');
      doc.setFontSize(13);
      doc.setTextColor(...C.text);
      doc.text(pdfText(cfg.EVENT_TITLE), PAGE.w - PAGE.m, 37, { align: 'right' });
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(8.5);
      doc.setTextColor(...C.text2);
      doc.text('Attendance report', PAGE.w - PAGE.m, 50, { align: 'right' });
      doc.setDrawColor(...C.green);
      doc.setLineWidth(3);
      doc.line(PAGE.m, 64, PAGE.w - PAGE.m, 64);

      doc.setDrawColor(...C.border);
      doc.setLineWidth(0.5);
      doc.line(PAGE.m, PAGE.h - 40, PAGE.w - PAGE.m, PAGE.h - 40);
      doc.setFontSize(8);
      doc.setTextColor(...C.text2);
      doc.text(pdfText(cfg.FOOTER), PAGE.m, PAGE.h - 26);
      doc.text(pdfText(`Generated ${generatedAt}  |  Page ${i} of ${pages}`), PAGE.w - PAGE.m, PAGE.h - 26, { align: 'right' });
    }
  }

  function buildReport(doc, v, thumbs) {
    const n = v.students.length;
    const details = [];
    if (v.teacher) details.push(`Activity: ${v.teacher.nombre}${v.teacher.salon ? `  |  ${v.teacher.salon}` : ''}`);
    details.push(v.teacher
      ? `${n} ${n === 1 ? 'student' : 'students'} chose ${state.isAdmin ? 'this teacher' : 'you as their teacher'}`
      : `${state.activities.length} activities  |  ${n} students registered`);
    if (v.focus && state.isAdmin) details.push(`Photos: ${v.focus.nombre}`);

    let y = titleBlock(doc, PAGE.top, v.teacher ? 'Attendance report · Students of' : 'Attendance report',
      v.teacher ? v.teacher.profesor : 'All teachers', details);
    y = statBoxes(doc, y, summary(v));
    y = sectionHeading(doc, y, "Students' progress",
      v.focus ? `Check-in time at ${v.focus.nombre}; other activities: done or pending` : 'Done or pending per activity');
    progressTable(doc, y, v, thumbs);
  }

  function fileSafe(text) {
    return pdfText(text).normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '');
  }

  // Dialog
  function openPdfDialog() {
    const v = currentView();
    const who = v.teacher ? (state.isAdmin ? `The students of ${v.teacher.profesor}` : 'Your students') : 'Every student';
    $('pdf-desc').textContent = v.focus
      ? `${who}: their check-in at ${v.focus.nombre}, and whether they completed the other activities.`
      : `${who} and whether they completed each activity.`;
    $('pdf-photos-label').hidden = !v.focus;
    $('pdf-photos-text').textContent = v.focus ? `Include ${v.focus.nombre} photo thumbnails` : '';
    setAlert('pdf-error', '');
    $('pdf-status').textContent = '';
    $('pdf-modal').hidden = false;
  }

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
    const v = currentView();
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
      if (v.focus && $('pdf-photos').checked) {
        const records = v.students.map((s) => recordOf(s, v.focus)).filter(Boolean);
        thumbs = await makeThumbnails(records, (done, total) => {
          $('pdf-status').textContent = `Adding photos… ${done} of ${total}`;
        });
      }

      $('pdf-status').textContent = 'Creating the PDF…';
      const doc = new window.jspdf.jsPDF({ unit: 'pt', format: 'letter' });
      doc.setProperties({ title: `${cfg.EVENT_TITLE} - Attendance report`, author: cfg.FOOTER });
      buildReport(doc, v, thumbs);

      const now = new Date();
      decoratePages(doc, logo, `${formatDate(now)}, ${formatTime(now)}`);
      const day = formatDateTimePlain(now).slice(0, 10);
      doc.save(`${fileSafe(cfg.EVENT_TITLE)}-${v.teacher ? fileSafe(v.teacher.profesor) : 'All-teachers'}-${day}.pdf`);

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
