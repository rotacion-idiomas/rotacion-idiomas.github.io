// Student check-in page.
(function () {
  const { createDb, formatDate, formatTime, escapeHtml, friendlyError,
    storageGet, storageSet, storageRemove, fillBranding } = window.App;

  const db = createDb({ auth: { persistSession: false, autoRefreshToken: false } });
  const STUDENT_KEY = 'rotation.student';
  const CODE_PATTERN = /^[A-Z0-9-]{3,30}$/;
  const PHOTO_MAX_SIDE = 1280;
  const PHOTO_MAX_BYTES = 200 * 1024;

  const state = {
    activities: [],
    activity: null,   // activity from the QR, or null
    student: null,    // { codigo, nombre, grado }
    done: [],         // [{ actividad_id, registrado_en }]
    photo: null,      // compressed Blob
    pending: null,    // student awaiting "Is this you?"
  };

  const $ = (id) => document.getElementById(id);

  // ---------------------------------------------------------------- screens
  function show(name) {
    document.querySelectorAll('.screen').forEach((s) => { s.hidden = s.id !== `s-${name}`; });
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
    const { data, error } = await db.from('actividades').select('id, nombre, salon, profesor').order('orden');
    if (error) throw error;
    return data;
  }

  async function fetchProgress(code) {
    const { data, error } = await db.rpc('progreso_estudiante', { p_codigo: code });
    if (error) throw error;
    return data || [];
  }

  function normalizeCode(value) {
    return String(value || '').replace(/\s+/g, '').toUpperCase();
  }

  function rememberStudent(student) {
    state.student = { codigo: student.codigo, nombre: student.nombre, grado: student.grado };
    storageSet(STUDENT_KEY, state.student);
  }

  function forgetStudent() {
    state.student = null;
    state.done = [];
    storageRemove(STUDENT_KEY);
  }

  // ---------------------------------------------------------------- progress
  function renderProgress(container) {
    const total = state.activities.length;
    const doneIds = new Set(state.done.map((d) => d.actividad_id));
    const count = state.activities.filter((a) => doneIds.has(a.id)).length;
    const pct = total ? Math.round((count / total) * 100) : 0;

    const items = state.activities.map((a) => {
      const record = state.done.find((d) => d.actividad_id === a.id);
      const current = state.activity && state.activity.id === a.id;
      const meta = record
        ? `Done · ${formatTime(record.registrado_en)}`
        : `${escapeHtml(a.salon)} · Pending`;
      return `<li class="${current ? 'is-current' : ''}">
        <span class="dot ${record ? 'is-done' : ''}" aria-hidden="true">${record ? '✓' : ''}</span>
        <span><span class="name">${escapeHtml(a.nombre)}</span><br><span class="meta">${meta}</span></span>
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
      state.activities = await fetchActivities();
    } catch (err) {
      return showError(err, init);
    }

    if (activityId) {
      state.activity = state.activities.find((a) => a.id === activityId) || null;
      if (!state.activity) return show('not-found');
      const tag = $('activity-tag');
      tag.innerHTML = `${escapeHtml(state.activity.nombre)} <small>· ${escapeHtml(state.activity.salon)}</small>`;
      tag.hidden = false;
    }

    if (!state.student) return showRegister();
    return goToMain();
  }

  async function goToMain() {
    show('loading');
    try {
      state.done = await fetchProgress(state.student.codigo);
    } catch (err) {
      return showError(err, goToMain);
    }

    if (!state.activity) {
      renderProgress($('welcome-progress'));
      return show('welcome');
    }

    const record = state.done.find((d) => d.actividad_id === state.activity.id);
    if (record) return showDone(record, false);

    resetPhoto();
    $('photo-name').textContent = state.student.nombre.split(' ')[0];
    renderProgress($('photo-progress'));
    show('photo');
  }

  // ---------------------------------------------------------------- register
  function showRegister(message) {
    selectTab('new');
    setAlert('register-error', message || '');
    show('register');
  }

  function selectTab(which) {
    $('tab-new').setAttribute('aria-selected', String(which === 'new'));
    $('tab-existing').setAttribute('aria-selected', String(which === 'existing'));
    $('form-new').hidden = which !== 'new';
    $('form-existing').hidden = which !== 'existing';
    setAlert('register-error', '');
  }
  $('tab-new').addEventListener('click', () => selectTab('new'));
  $('tab-existing').addEventListener('click', () => selectTab('existing'));

  $('form-new').addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = $('f-name').value.trim().replace(/\s+/g, ' ');
    const code = normalizeCode($('f-code').value);
    const grade = $('f-grade').value.trim();

    if (name.length < 3 || !name.includes(' ')) return setAlert('register-error', 'Please write your full name (first and last name).');
    if (!CODE_PATTERN.test(code)) return setAlert('register-error', 'Please check your student ID. Use 3 to 30 letters or numbers, without spaces or symbols.');
    if (!grade) return setAlert('register-error', 'Please write your course or group.');
    setAlert('register-error', '');

    const button = e.submitter || e.target.querySelector('button');
    setBusy(button, true, 'Saving…');
    const { data, error } = await db.rpc('registrar_estudiante', { p_codigo: code, p_nombre: name, p_grado: grade });
    setBusy(button, false);

    if (error) return setAlert('register-error', friendlyError(error));
    if (data.status === 'exists') return askIsThisYou(data);
    rememberStudent(data);
    goToMain();
  });

  $('form-existing').addEventListener('submit', async (e) => {
    e.preventDefault();
    const code = normalizeCode($('f-code-existing').value);
    if (!CODE_PATTERN.test(code)) return setAlert('register-error', 'Please check your student ID. Use 3 to 30 letters or numbers, without spaces or symbols.');
    setAlert('register-error', '');

    const button = e.submitter || e.target.querySelector('button');
    setBusy(button, true, 'Searching…');
    const { data, error } = await db.rpc('buscar_estudiante', { p_codigo: code });
    setBusy(button, false);

    if (error) return setAlert('register-error', friendlyError(error));
    if (!data) return setAlert('register-error', `We couldn't find the student ID ${code}. If this is your first time, choose "First time here".`);
    askIsThisYou(data);
  });

  function askIsThisYou(student) {
    state.pending = student;
    $('confirm-code').textContent = student.codigo;
    $('confirm-name').textContent = student.nombre;
    $('confirm-grade').textContent = student.grado;
    show('confirm');
  }
  $('confirm-yes').addEventListener('click', () => {
    rememberStudent(state.pending);
    state.pending = null;
    goToMain();
  });
  $('confirm-no').addEventListener('click', () => {
    state.pending = null;
    showRegister('Please check your student ID and try again.');
  });

  $('switch-student').addEventListener('click', () => {
    forgetStudent();
    $('form-new').reset();
    $('form-existing').reset();
    showRegister();
  });

  // ---------------------------------------------------------------- photo
  function resetPhoto() {
    state.photo = null;
    const preview = $('photo-preview');
    if (preview.src) URL.revokeObjectURL(preview.src);
    preview.removeAttribute('src');
    preview.hidden = true;
    $('photo-empty').hidden = false;
    $('btn-take').hidden = false;
    $('btn-submit').hidden = true;
    $('btn-retake').hidden = true;
    $('photo-input').value = '';
    setAlert('photo-error', '');
  }

  function openCamera() { $('photo-input').click(); }
  $('btn-take').addEventListener('click', openCamera);
  $('btn-retake').addEventListener('click', openCamera);

  $('photo-input').addEventListener('change', async (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    setAlert('photo-error', '');
    const takeButton = $('btn-take').hidden ? $('btn-retake') : $('btn-take');
    setBusy(takeButton, true, 'Preparing photo…');
    try {
      const blob = await compressImage(file);
      state.photo = blob;
      const preview = $('photo-preview');
      if (preview.src) URL.revokeObjectURL(preview.src);
      preview.src = URL.createObjectURL(blob);
      preview.hidden = false;
      $('photo-empty').hidden = true;
      $('btn-take').hidden = true;
      $('btn-submit').hidden = false;
      $('btn-retake').hidden = false;
    } catch (err) {
      console.error(err);
      setAlert('photo-error', "We couldn't read that photo. Please take it again.");
    } finally {
      setBusy(takeButton, false);
      e.target.value = '';
    }
  });

  function loadImage(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('image_load_failed')); };
      img.src = url;
    });
  }

  // Resize to at most 1280 px on the long side and keep it under ~200 KB.
  async function compressImage(file) {
    const img = await loadImage(file);
    const scale = Math.min(1, PHOTO_MAX_SIDE / Math.max(img.naturalWidth, img.naturalHeight));
    let width = Math.round(img.naturalWidth * scale);
    let height = Math.round(img.naturalHeight * scale);
    let quality = 0.8;
    const canvas = document.createElement('canvas');
    let blob = null;

    for (let attempt = 0; attempt < 10; attempt++) {
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, width, height);
      ctx.drawImage(img, 0, 0, width, height);
      blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));
      if (!blob) throw new Error('compress_failed');
      if (blob.size <= PHOTO_MAX_BYTES) break;
      if (quality > 0.55) {
        quality -= 0.1;
      } else {
        width = Math.round(width * 0.85);
        height = Math.round(height * 0.85);
      }
    }
    return blob;
  }

  $('btn-submit').addEventListener('click', submitAttendance);

  async function submitAttendance() {
    if (!state.photo) return;
    if (!navigator.onLine) return setAlert('photo-error', "You're offline. Check your internet connection and try again.");
    setAlert('photo-error', '');
    const button = $('btn-submit');
    $('btn-retake').disabled = true;
    setBusy(button, true, 'Sending…');

    try {
      const path = `${state.activity.id}/${state.student.codigo}-${Date.now()}.jpg`;
      const upload = await db.storage.from('evidencias')
        .upload(path, state.photo, { contentType: 'image/jpeg', upsert: false });
      if (upload.error) throw upload.error;

      const { data, error } = await db.rpc('registrar_asistencia', {
        p_codigo: state.student.codigo, p_actividad: state.activity.id, p_foto_path: path,
      });
      if (error) throw error;

      state.done = await fetchProgress(state.student.codigo).catch(() => [...state.done, data]);
      showDone(data, data.status === 'created');
    } catch (err) {
      if (/student_not_found/.test(err.message || '')) {
        forgetStudent();
        return showRegister('We could not find your registration. Please register again.');
      }
      console.error(err);
      setAlert('photo-error', friendlyError(err));
    } finally {
      setBusy(button, false);
      $('btn-retake').disabled = false;
    }
  }

  // ---------------------------------------------------------------- done
  function showDone(record, isNew) {
    const when = `${formatDate(record.registrado_en)} at ${formatTime(record.registrado_en)}`;
    $('done-icon').classList.toggle('is-warning', !isNew);
    $('done-icon').textContent = isNew ? '✓' : '!';
    $('done-title').textContent = isNew
      ? `You're checked in to ${state.activity.nombre}!`
      : `You already checked in to ${state.activity.nombre}`;
    $('done-text').textContent = isNew
      ? `${state.student.nombre} · ${when}`
      : `Your check-in was saved on ${when}. There's no need to do it again.`;

    const { count, total } = renderProgress($('done-progress'));
    $('done-next').textContent = count >= total
      ? `🎉 Great job! You've completed all ${total} activities.`
      : 'Next: go to one of your pending classrooms and scan its QR code.';
    show('done');
  }

  // ---------------------------------------------------------------- start
  fillBranding();
  init();
})();
