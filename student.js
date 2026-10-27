// Student check-in page.
(function () {
  const { createDb, formatDate, formatTime, escapeHtml, friendlyError,
    storageGet, storageSet, storageRemove, fillBranding } = window.App;

  const db = createDb({ auth: { persistSession: false, autoRefreshToken: false } });
  const STUDENT_KEY = 'rotation.student';
  const JSQR_URL = 'https://cdn.jsdelivr.net/npm/jsqr@1.4.0/dist/jsQR.min.js';
  const PHOTO_MAX_SIDE = 1280;
  const PHOTO_MAX_BYTES = 200 * 1024;

  const state = {
    activities: [],
    activity: null,   // activity being checked in, or null
    student: null,    // { codigo, nombre, grado }
    done: [],         // [{ actividad_id, registrado_en }]
    photo: null,      // compressed Blob
    draft: null,      // { nombre, grado } waiting for "Is this you?"
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
    const { data, error } = await db.from('actividades').select('id, nombre, salon, profesor').order('orden');
    if (error) throw error;
    return data;
  }

  async function fetchProgress(code) {
    const { data, error } = await db.rpc('progreso_estudiante', { p_codigo: code });
    if (error) throw error;
    return data || [];
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

  function setActivity(activity) {
    state.activity = activity;
    const tag = $('activity-tag');
    tag.hidden = !activity;
    if (activity) {
      tag.innerHTML = `${escapeHtml(activity.nombre)} <small>· ${escapeHtml(activity.salon)}</small>`;
      history.replaceState(null, '', `?activity=${encodeURIComponent(activity.id)}`);
    }
  }

  function allDone() {
    const doneIds = new Set(state.done.map((d) => d.actividad_id));
    return state.activities.length > 0 && state.activities.every((a) => doneIds.has(a.id));
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
    setAlert('register-error', message || '');
    show('register');
  }

  async function register(nombre, grado, confirmed, button) {
    setBusy(button, true, 'Saving…');
    const { data, error } = await db.rpc('registrar_estudiante_nuevo', {
      p_nombre: nombre, p_grado: grado, p_confirmado: confirmed,
    });
    setBusy(button, false);

    if (error) {
      setAlert('register-error', friendlyError(error));
      return show('register');
    }
    if (data.status === 'possible_match') {
      state.draft = { nombre, grado };
      return showMatches(data.matches);
    }
    state.draft = null;
    rememberStudent(data);
    goToMain();
  }

  $('form-new').addEventListener('submit', (e) => {
    e.preventDefault();
    const nombre = $('f-name').value.trim().replace(/\s+/g, ' ');
    const grado = $('f-grade').value.trim();

    if (nombre.length < 3 || !nombre.includes(' ')) return setAlert('register-error', 'Please write your full name (first and last name).');
    if (!grado) return setAlert('register-error', 'Please write your course or group.');
    setAlert('register-error', '');
    register(nombre, grado, false, e.submitter || e.target.querySelector('button'));
  });

  function showMatches(matches) {
    $('confirm-list').innerHTML = matches.map((m, i) => `
      <button class="match-btn" type="button" data-index="${i}">
        <span><strong>${escapeHtml(m.nombre)}</strong><br><span class="muted">${escapeHtml(m.grado)}</span></span>
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
    register(state.draft.nombre, state.draft.grado, true, e.currentTarget);
  });

  $('switch-student').addEventListener('click', () => {
    forgetStudent();
    $('form-new').reset();
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

    const { total } = renderProgress($('done-progress'));
    const finished = allDone();
    $('btn-next').hidden = finished;
    $('done-next').textContent = finished
      ? `🎉 Great job! You've completed all ${total} activities.`
      : 'When you get to your next classroom, tap "Next activity" and scan its QR code.';
    show('done');
  }

  // ---------------------------------------------------------------- QR scanner
  const scanner = {
    stream: null,
    detector: null,
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

  async function getDetector() {
    if ('BarcodeDetector' in window) {
      try {
        const formats = await window.BarcodeDetector.getSupportedFormats();
        if (formats.includes('qr_code')) {
          const detector = new window.BarcodeDetector({ formats: ['qr_code'] });
          return async (video) => {
            const codes = await detector.detect(video);
            return codes.length ? codes[0].rawValue : null;
          };
        }
      } catch { /* fall back to jsQR */ }
    }
    if (!window.jsQR) await loadScript(JSQR_URL);
    return async (video) => {
      const scale = Math.min(1, 640 / Math.max(video.videoWidth, video.videoHeight));
      const w = Math.round(video.videoWidth * scale);
      const h = Math.round(video.videoHeight * scale);
      if (!w || !h) return null;
      scanner.canvas.width = w;
      scanner.canvas.height = h;
      const ctx = scanner.canvas.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(video, 0, 0, w, h);
      const code = window.jsQR(ctx.getImageData(0, 0, w, h).data, w, h, { inversionAttempts: 'dontInvert' });
      return code ? code.data : null;
    };
  }

  async function openScanner() {
    $('scanner').hidden = false;
    $('scanner').classList.remove('is-found');
    document.body.style.overflow = 'hidden';
    scannerMessage('Starting camera…');

    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      return scannerMessage("This browser can't open the camera here. Scan the QR code with your phone's camera app instead.", true);
    }

    try {
      scanner.stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' } }, audio: false,
      });
    } catch (err) {
      console.error(err);
      const denied = err && /NotAllowed|Permission/i.test(err.name || err.message);
      return scannerMessage(denied
        ? 'Camera access was blocked. Allow camera access for this site in your browser settings and try again.'
        : "We couldn't open the camera. Close other apps using it and try again.", true);
    }

    // The scanner may have been closed while waiting for permission.
    if ($('scanner').hidden) return stopCamera();

    const video = $('scanner-video');
    video.srcObject = scanner.stream;
    try { await video.play(); } catch { /* autoplay attribute handles it */ }

    try {
      scanner.detector = await getDetector();
    } catch (err) {
      console.error(err);
      return scannerMessage(friendlyError(err), true);
    }
    scannerMessage('Point your camera at the QR code posted at the classroom door.');
    scanLoop();
  }

  function scanLoop() {
    scanner.timer = setTimeout(async () => {
      if ($('scanner').hidden || !scanner.stream) return;
      const video = $('scanner-video');
      let text = null;
      if (video.readyState >= 2) {
        try { text = await scanner.detector(video); } catch (err) { console.error(err); }
      }
      if (text && handleScan(text)) return;
      scanLoop();
    }, 200);
  }

  // Returns true when the code was a valid activity and the scanner closed.
  function handleScan(text) {
    let id = '';
    try {
      const url = new URL(text, location.href);
      id = (url.searchParams.get('activity') || url.searchParams.get('actividad') || '').trim().toLowerCase();
    } catch { /* not a URL */ }

    const activity = state.activities.find((a) => a.id === id);
    if (!activity) {
      if (Date.now() - scanner.lastMessageAt > 1500) {
        scanner.lastMessageAt = Date.now();
        scannerMessage("That QR code isn't from the Language Rotation. Try the one posted at the classroom door.", true);
      }
      return false;
    }

    $('scanner').classList.add('is-found');
    scannerMessage(`Found: ${activity.nombre} · ${activity.salon}`);
    if (navigator.vibrate) navigator.vibrate(80);
    setTimeout(() => {
      closeScanner();
      setActivity(activity);
      if (!state.student) return showRegister();
      goToMain();
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

  document.querySelectorAll('[data-scan]').forEach((b) => b.addEventListener('click', openScanner));
  $('scanner-close').addEventListener('click', closeScanner);
  $('scanner-cancel').addEventListener('click', closeScanner);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('scanner').hidden) closeScanner(); });
  document.addEventListener('visibilitychange', () => { if (document.hidden && !$('scanner').hidden) closeScanner(); });

  // ---------------------------------------------------------------- start
  fillBranding();
  init();
})();
