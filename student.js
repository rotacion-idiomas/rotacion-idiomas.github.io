// Student check-in page.
(function () {
  const { createDb, formatDate, formatTime, escapeHtml, friendlyError,
    storageGet, storageSet, storageRemove, fillBranding, groupName } = window.App;

  const db = createDb({ auth: { persistSession: false, autoRefreshToken: false } });
  const STUDENT_KEY = 'rotation.student';
  const JSQR_URL = 'https://cdn.jsdelivr.net/npm/jsqr@1.4.0/dist/jsQR.min.js';
  const QR_MAX_SIDE = 1024;     // jsQR (iPhone) reads the picture at this size

  const state = {
    activities: [],   // every activity, open or not
    teachers: [],     // [{ id, nombre, grupos }]
    activity: null,   // activity being checked in, or null
    student: null,    // { codigo, nombre, profesor_id, profesor, grupo }
    done: [],         // [{ actividad_id, registrado_en }]
    draft: null,      // { nombre, profesor, grupo } waiting for "Is this you?"
  };

  const $ = (id) => document.getElementById(id);

  // ---------------------------------------------------------------- screens
  function show(name) {
    document.querySelectorAll('.screen').forEach((s) => { s.hidden = s.id !== `s-${name}`; });
    const showId = state.student && !['register', 'confirm', 'loading'].includes(name);
    $('student-id').hidden = !showId;
    if (showId) $('student-id').innerHTML = `Your student ID: <strong>${escapeHtml(state.student.codigo)}</strong>`;
    window.scrollTo(0, 0);
  }

  let retryAction = null;
  function showError(err, retry, title) {
    console.error(err);
    $('error-title').textContent = title || 'Something went wrong';
    $('error-text').textContent = ' ' + friendlyError(err);
    retryAction = retry;
    show('error');
  }
  $('error-retry').addEventListener('click', () => retryAction && retryAction());

  function setAlert(id, message) {
    $(id).hidden = !message;
    $(`${id}-text`).textContent = message || '';
  }

  function setBusy(button, busy, busyText) {
    if (busy) {
      button.dataset.label = button.innerHTML;
      button.innerHTML = `<span class="spinner"></span>${escapeHtml(busyText)}`;
      button.disabled = true;
    } else if (button.dataset.label) {
      button.innerHTML = button.dataset.label;
      button.disabled = false;
    }
  }

  // ---------------------------------------------------------------- data
  async function fetchActivities() {
    const { data, error } = await db.from('actividades')
      .select('id, nombre, salon, profesor, profesor_id, activa').order('orden');
    if (error) throw error;
    return data;
  }

  async function fetchTeachers() {
    const { data, error } = await db.rpc('profesores_publicos');
    if (error) throw error;
    return data || [];
  }

  // Teachers can switch their open activity at any time, so the lists are reloaded often.
  async function loadLists() {
    const [activities, teachers] = await Promise.all([fetchActivities(), fetchTeachers()]);
    state.activities = activities;
    state.teachers = teachers;
    if (state.activity) state.activity = activityById(state.activity.id) || state.activity;
  }

  async function fetchProgress(code) {
    const { data, error } = await db.rpc('progreso_estudiante', { p_codigo: code });
    if (error) throw error;
    return data || [];
  }

  function rememberStudent(student) {
    state.student = {
      codigo: student.codigo, nombre: student.nombre,
      profesor_id: student.profesor_id, profesor: student.profesor, grupo: student.grupo,
    };
    storageSet(STUDENT_KEY, state.student);
  }

  function forgetStudent() {
    state.student = null;
    state.done = [];
    storageRemove(STUDENT_KEY);
  }

  function setActivity(activity) {
    state.activity = activity;
    const tag = $('activity-tag');
    tag.hidden = !activity;
    if (activity) {
      tag.innerHTML = `${escapeHtml(activity.nombre)}${activity.salon ? ` <small>· ${escapeHtml(activity.salon)}</small>` : ''}`;
      history.replaceState(null, '', `?activity=${encodeURIComponent(activity.id)}`);
    }
  }

  function activityById(id) {
    return state.activities.find((a) => a.id === id) || null;
  }

  function teacherById(id) {
    return state.teachers.find((t) => t.id === id) || null;
  }

  // One stop per teacher, at the activity they have open now.
  // Students need one check-in with each teacher, whichever activity it was.
  function stops() {
    return state.teachers
      .map((teacher) => ({ teacher, activity: state.activities.find((a) => a.profesor_id === teacher.id && a.activa) }))
      .filter((s) => s.activity);
  }

  function recordWith(teacherId) {
    return state.done.find((d) => {
      const a = activityById(d.actividad_id);
      return a && a.profesor_id === teacherId;
    }) || null;
  }

  function allDone() {
    const list = stops();
    return list.length > 0 && list.every((s) => recordWith(s.teacher.id));
  }

  // ---------------------------------------------------------------- progress
  function renderProgress(container) {
    const list = stops();
    const total = list.length;
    const count = list.filter((s) => recordWith(s.teacher.id)).length;
    const pct = total ? Math.round((count / total) * 100) : 0;

    const items = list.map(({ teacher, activity }) => {
      const record = recordWith(teacher.id);
      const shown = (record && activityById(record.actividad_id)) || activity;
      const current = state.activity && state.activity.profesor_id === teacher.id;
      const meta = record
        ? `${escapeHtml(teacher.nombre)} · Done · ${formatTime(record.registrado_en)}`
        : `${escapeHtml(teacher.nombre)}${activity.salon ? ` · ${escapeHtml(activity.salon)}` : ''} · Pending`;
      return `<li class="${current ? 'is-current' : ''}">
        <span class="dot ${record ? 'is-done' : ''}" aria-hidden="true">${record ? '✓' : ''}</span>
        <span><span class="name">${escapeHtml(shown.nombre)}</span><br><span class="meta">${meta}</span></span>
      </li>`;
    }).join('');

    container.innerHTML = `
      <div class="progress-head">
        <strong>Your progress</strong>
        <span class="muted">${count} of ${total} activities completed</span>
      </div>
      <div class="progress-bar" role="progressbar" aria-valuemin="0" aria-valuemax="${total}" aria-valuenow="${count}">
        <span style="width:${pct}%"></span>
      </div>
      <ul class="progress-list">${items}</ul>`;
    container.hidden = false;
    return { count, total };
  }

  // ---------------------------------------------------------------- flow
  async function init() {
    show('loading');
    const params = new URLSearchParams(location.search);
    const activityId = (params.get('activity') || params.get('actividad') || '').trim().toLowerCase();
    state.student = storageGet(STUDENT_KEY);

    try {
      await loadLists();
    } catch (err) {
      return showError(err, init);
    }

    if (activityId) {
      const activity = state.activities.find((a) => a.id === activityId);
      if (!activity) return show('not-found');
      setActivity(activity);
    }

    // First visit, whichever QR the student scans first.
    if (!state.student) return showRegister();
    return goToMain();
  }

  async function goToMain() {
    show('loading');
    try {
      const [found, done] = await Promise.all([
        db.rpc('buscar_estudiante', { p_codigo: state.student.codigo }),
        fetchProgress(state.student.codigo),
        loadLists(),
      ]);
      if (found.error) throw found.error;
      // The registration saved on this phone no longer exists (e.g. data was reset).
      if (!found.data) {
        forgetStudent();
        return showRegister();
      }
      rememberStudent(found.data);
      state.done = done;
    } catch (err) {
      return showError(err, goToMain);
    }

    if (allDone()) return showThanks();

    if (!state.activity) {
      renderProgress($('welcome-progress'));
      return show('welcome');
    }

    const record = recordWith(state.activity.profesor_id);
    if (record) return showDone(record, false);
    if (!state.activity.activa) return showClosed();
    showCheckin();
  }

  // ---------------------------------------------------------------- register
  function showRegister(message) {
    fillTeacherSelect();
    setAlert('register-error', message || '');
    show('register');
  }

  function fillTeacherSelect() {
    const select = $('f-teacher');
    const current = select.value;
    select.innerHTML = '<option value="">Choose your teacher…</option>' + state.teachers.map((t) =>
      `<option value="${t.id}">${escapeHtml(t.nombre)}</option>`).join('');
    select.value = state.teachers.some((t) => String(t.id) === current) ? current : '';
    fillGroupSelect();
  }

  // Shown once a teacher is chosen; with only one group, Group 1 is already selected.
  function fillGroupSelect() {
    const teacher = teacherById(Number($('f-teacher').value));
    const groups = teacher ? teacher.grupos : 0;
    const select = $('f-group');
    const current = Number(select.value);
    $('f-group-field').hidden = !teacher;
    select.innerHTML = (groups > 1 ? '<option value="">Choose your group…</option>' : '')
      + Array.from({ length: groups }, (_, i) => `<option value="${i + 1}">${escapeHtml(groupName(teacher, i + 1))}</option>`).join('');
    if (groups === 1) select.value = '1';
    else select.value = current && current <= groups ? String(current) : '';
    $('f-group-hint').textContent = groups > 1
      ? 'Choose the group (level) you are enrolled in.'
      : 'Your teacher has only one group.';
  }
  $('f-teacher').addEventListener('change', fillGroupSelect);

  function groupLabel(student) {
    const teacher = teacherById(student.profesor_id);
    return teacher && teacher.grupos > 1 ? ` · ${groupName(teacher, student.grupo)}` : '';
  }

  async function register(nombre, profesor, grupo, confirmed, button) {
    setBusy(button, true, 'Saving…');
    const { data, error } = await db.rpc('registrar_estudiante_nuevo', {
      p_nombre: nombre, p_profesor: profesor, p_grupo: grupo, p_confirmado: confirmed,
    });
    setBusy(button, false);

    if (error) {
      setAlert('register-error', friendlyError(error));
      return show('register');
    }
    if (data.status === 'possible_match') {
      state.draft = { nombre, profesor, grupo };
      return showMatches(data.matches);
    }
    state.draft = null;
    rememberStudent(data);
    goToMain();
  }

  $('form-new').addEventListener('submit', (e) => {
    e.preventDefault();
    const nombre = $('f-name').value.trim().replace(/\s+/g, ' ');
    const teacher = teacherById(Number($('f-teacher').value));
    const grupo = Number($('f-group').value);

    if (nombre.length < 3 || !nombre.includes(' ')) return setAlert('register-error', 'Please write your full name (first and last name).');
    if (!teacher) return setAlert('register-error', 'Please choose your teacher.');
    if (!grupo) return setAlert('register-error', 'Please choose your group.');
    setAlert('register-error', '');
    register(nombre, teacher.id, grupo, false, e.submitter || e.target.querySelector('button'));
  });

  function showMatches(matches) {
    $('confirm-list').innerHTML = matches.map((m, i) => `
      <button class="match-btn" type="button" data-index="${i}">
        <span><strong>${escapeHtml(m.nombre)}</strong><br><span class="muted">${m.profesor ? `Teacher: ${escapeHtml(m.profesor)}${groupLabel(m)}` : ''}</span></span>
        <span class="arrow" aria-hidden="true">›</span>
      </button>`).join('');
    $('confirm-list').querySelectorAll('.match-btn').forEach((button) => {
      button.addEventListener('click', () => {
        rememberStudent(matches[Number(button.dataset.index)]);
        state.draft = null;
        goToMain();
      });
    });
    show('confirm');
  }

  $('confirm-no').addEventListener('click', (e) => {
    if (!state.draft) return showRegister();
    register(state.draft.nombre, state.draft.profesor, state.draft.grupo, true, e.currentTarget);
  });

  $('switch-student').addEventListener('click', () => {
    forgetStudent();
    $('form-new').reset();
    showRegister();
  });

  // ---------------------------------------------------------------- check-in
  // The student checks in by scanning the activity's QR code. Nothing is uploaded.
  function showCheckin(message) {
    $('checkin-name').textContent = state.student.nombre.split(' ')[0];
    renderProgress($('checkin-progress'));
    show('checkin');
    setAlert('checkin-error', message || '');
  }

  async function checkIn(activity) {
    setActivity(activity);
    if (!state.student) return showRegister();
    if (!navigator.onLine) return showCheckin("You're offline. Check your internet connection and try again.");
    show('loading');

    try {
      const { data, error } = await db.rpc('registrar_asistencia', {
        p_codigo: state.student.codigo, p_actividad: activity.id,
      });
      if (error) throw error;

      state.done = await fetchProgress(state.student.codigo).catch(() => [...state.done, data]);
      showDone(data, data.status === 'created');
    } catch (err) {
      if (/student_not_found/.test(err.message || '')) {
        forgetStudent();
        return showRegister('We could not find your registration. Please register again.');
      }
      // The teacher switched to another activity just now.
      if (/activity_inactive/.test(err.message || '')) return goToMain();
      console.error(err);
      showCheckin(friendlyError(err));
    }
  }

  // ---------------------------------------------------------------- done
  function showDone(record, isNew) {
    if (allDone()) return showThanks();

    const activity = activityById(record.actividad_id) || state.activity;
    const teacher = teacherById(activity.profesor_id);
    const otherActivity = activity.id !== state.activity.id;
    const when = `${formatDate(record.registrado_en)} at ${formatTime(record.registrado_en)}`;
    $('done-icon').classList.toggle('is-warning', !isNew);
    $('done-icon').textContent = isNew ? '✓' : '!';
    if (isNew) {
      $('done-title').textContent = `You're checked in to ${activity.nombre}!`;
      $('done-text').textContent = `${state.student.nombre} · ${when}`;
    } else if (otherActivity) {
      $('done-title').textContent = `You already did ${teacher ? `${teacher.nombre}'s` : 'this teacher\'s'} activity`;
      $('done-text').textContent = `You checked in to ${activity.nombre} on ${when}. You only need one activity with each teacher.`;
    } else {
      $('done-title').textContent = `You already checked in to ${activity.nombre}`;
      $('done-text').textContent = `Your check-in was saved on ${when}. There's no need to do it again.`;
    }

    renderProgress($('done-progress'));
    $('done-next').textContent = 'In your next classroom, tap "Next activity" and scan its QR code.';
    show('done');
  }

  // The QR is from an activity the teacher isn't running right now.
  function showClosed() {
    const activity = state.activity;
    const teacher = teacherById(activity.profesor_id);
    const open = state.activities.find((a) => a.profesor_id === activity.profesor_id && a.activa);
    $('closed-title').textContent = `${activity.nombre} isn't open right now`;
    $('closed-text').textContent = ' ' + (open
      ? `${teacher ? teacher.nombre : 'The teacher'} is running ${open.nombre} now. Scan the QR code of that activity.`
      : 'Please ask your teacher for help.');
    renderProgress($('closed-progress'));
    show('closed');
  }

  function showThanks() {
    const total = stops().length;
    $('thanks-title').textContent = `Thank you, ${state.student.nombre.split(' ')[0]}!`;
    $('thanks-text').textContent = `You've completed all ${total} activities of the ${window.App.cfg.EVENT_TITLE}.`;
    renderProgress($('thanks-progress'));
    show('thanks');
  }

  // Sign the student out of this phone and go back to the registration screen.
  $('btn-exit').addEventListener('click', () => {
    forgetStudent();
    state.activity = null;
    $('activity-tag').hidden = true;
    history.replaceState(null, '', location.pathname);
    $('form-new').reset();
    showRegister();
  });

  // ---------------------------------------------------------------- QR scanner
  // Rear camera inside the page. The QR code tells which activity the check-in is for.
  const scanner = {
    stream: null,
    readQr: null,         // async (video or image) => text or null
    timer: null,
    canvas: document.createElement('canvas'),
    lastMessageAt: 0,
  };

  function scannerMessage(text, isError) {
    $('scanner-msg').textContent = text;
    $('scanner-msg').classList.toggle('is-error', !!isError);
  }

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = src;
      script.onload = resolve;
      script.onerror = () => reject(new Error('Failed to fetch the scanner'));
      document.head.appendChild(script);
    });
  }

  // Reads a QR code from a video or image: the browser's own reader when it
  // has one (Android), otherwise jsQR (iPhone).
  async function getQrReader() {
    if ('BarcodeDetector' in window) {
      try {
        const formats = await window.BarcodeDetector.getSupportedFormats();
        if (formats.includes('qr_code')) {
          const detector = new window.BarcodeDetector({ formats: ['qr_code'] });
          return async (source) => {
            const codes = await detector.detect(source);
            return codes.length ? codes[0].rawValue : null;
          };
        }
      } catch { /* fall back to jsQR */ }
    }
    if (!window.jsQR) await loadScript(JSQR_URL);
    return async (source) => {
      const sw = source.videoWidth || source.naturalWidth || source.width;
      const sh = source.videoHeight || source.naturalHeight || source.height;
      const scale = Math.min(1, QR_MAX_SIDE / Math.max(sw, sh));
      const w = Math.round(sw * scale);
      const h = Math.round(sh * scale);
      if (!w || !h) return null;
      scanner.canvas.width = w;
      scanner.canvas.height = h;
      const ctx = scanner.canvas.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(source, 0, 0, w, h);
      const code = window.jsQR(ctx.getImageData(0, 0, w, h).data, w, h, { inversionAttempts: 'dontInvert' });
      return code ? code.data : null;
    };
  }

  // Is this QR code an activity where the student can check in now?
  function checkCode(text) {
    let id = '';
    try {
      const url = new URL(text, location.href);
      id = (url.searchParams.get('activity') || url.searchParams.get('actividad') || '').trim().toLowerCase();
    } catch { /* not a URL */ }
    const activity = activityById(id);
    if (!activity) return { error: "That QR code isn't from the Activity Rotation. Try the one posted in the classroom." };
    if (state.student && recordWith(activity.profesor_id)) {
      const teacher = teacherById(activity.profesor_id);
      return { error: `You already did ${teacher ? `${teacher.nombre}'s` : 'this teacher\'s'} activity.` };
    }
    if (!activity.activa) return { error: `${activity.nombre} isn't open right now.` };
    return { activity };
  }

  function cameraFailed(message) {
    scannerMessage(message, true);
    $('scanner-fallback').hidden = false;
  }

  async function openScanner() {
    $('scanner').hidden = false;
    $('scanner').classList.remove('is-found');
    $('scanner-fallback').hidden = true;
    document.body.style.overflow = 'hidden';
    scannerMessage('Starting camera…');
    loadLists().catch((err) => console.error(err));   // so newly added or switched activities are recognized

    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      return cameraFailed("This browser can't open the camera here. Use your phone's camera app instead.");
    }

    try {
      scanner.stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' } }, audio: false,
      });
    } catch (err) {
      console.error(err);
      const denied = err && /NotAllowed|Permission/i.test(err.name || err.message);
      return cameraFailed(denied
        ? 'Camera access was blocked. Allow the camera for this site in your browser settings, or use your camera app.'
        : "We couldn't open the camera. Close other apps using it and try again.");
    }

    // The scanner may have been closed while waiting for permission.
    if ($('scanner').hidden) return stopCamera();

    const video = $('scanner-video');
    video.srcObject = scanner.stream;
    try { await video.play(); } catch { /* autoplay attribute handles it */ }

    try {
      scanner.readQr = await getQrReader();
    } catch (err) {
      console.error(err);
      return cameraFailed(friendlyError(err));
    }
    scannerMessage("Point your camera at the classroom's QR code.");
    scanLoop();
  }

  function scanLoop() {
    scanner.timer = setTimeout(async () => {
      if ($('scanner').hidden || !scanner.stream) return;
      const video = $('scanner-video');
      let text = null;
      if (video.readyState >= 2) {
        try { text = await scanner.readQr(video); } catch (err) { console.error(err); }
      }
      if (text && handleScan(text)) return;
      scanLoop();
    }, 200);
  }

  // Returns true when the code was valid and the scanner closed.
  function handleScan(text) {
    const result = checkCode(text);
    if (!result.activity) {
      if (Date.now() - scanner.lastMessageAt > 1500) {
        scanner.lastMessageAt = Date.now();
        scannerMessage(result.error, true);
      }
      return false;
    }

    const { activity } = result;
    $('scanner').classList.add('is-found');
    scannerMessage(`Found: ${activity.nombre}${activity.salon ? ` · ${activity.salon}` : ''}`);
    if (navigator.vibrate) navigator.vibrate(80);
    setTimeout(() => {
      closeScanner();
      checkIn(activity);
    }, 350);
    return true;
  }

  function stopCamera() {
    clearTimeout(scanner.timer);
    if (scanner.stream) scanner.stream.getTracks().forEach((t) => t.stop());
    scanner.stream = null;
    $('scanner-video').srcObject = null;
  }

  function closeScanner() {
    stopCamera();
    $('scanner').hidden = true;
    document.body.style.overflow = '';
  }

  function loadImage(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('image_load_failed')); };
      img.src = url;
    });
  }

  // Without the live camera: a picture from the phone's camera app, only to read
  // the QR code in it. The picture is not saved or uploaded.
  $('scanner-fallback').addEventListener('click', () => {
    closeScanner();
    $('photo-input').click();
  });

  $('photo-input').addEventListener('change', async (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    e.target.value = '';
    if (!state.student) return showRegister();
    try {
      const text = await (await getQrReader())(await loadImage(file));
      const result = text ? checkCode(text) : { error: "We couldn't see the QR code in your picture. Take it again closer to the code." };
      if (!result.activity) return showCheckin(result.error);
      checkIn(result.activity);
    } catch (err) {
      console.error(err);
      showCheckin("We couldn't read that picture. Please take it again.");
    }
  });

  document.querySelectorAll('[data-scan]').forEach((b) => b.addEventListener('click', openScanner));
  $('scanner-close').addEventListener('click', closeScanner);
  $('scanner-cancel').addEventListener('click', closeScanner);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('scanner').hidden) closeScanner(); });
  document.addEventListener('visibilitychange', () => { if (document.hidden && !$('scanner').hidden) closeScanner(); });

  // ---------------------------------------------------------------- start
  fillBranding();
  init();
})();
