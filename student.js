// Student check-in page.
(function () {
  const { createDb, formatDate, formatTime, escapeHtml, friendlyError,
    storageGet, storageSet, storageRemove, fillBranding, groupName } = window.App;

  const db = createDb({ auth: { persistSession: false, autoRefreshToken: false } });
  const STUDENT_KEY = 'rotation.student';
  const JSQR_URL = 'https://cdn.jsdelivr.net/npm/jsqr@1.4.0/dist/jsQR.min.js';
  const MEDIAPIPE_URL = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14';
  const FACE_MODEL_URL = 'https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/1/blaze_face_short_range.tflite';
  const PHOTO_MAX_SIDE = 1280;
  const PHOTO_MAX_BYTES = 200 * 1024;
  const QR_MAX_SIDE = 1280;      // the wall's QR code is small in a selfie: read it at good resolution
  const QR_GRACE_MS = 2500;      // a code seen this recently still counts
  const CROWN_TILT = 0.35;       // about 20°, to one side

  const state = {
    activities: [],   // every activity, open or not
    teachers: [],     // [{ id, nombre, grupos }]
    activity: null,   // activity being checked in, or null
    student: null,    // { codigo, nombre, profesor_id, profesor, grupo }
    done: [],         // [{ actividad_id, registrado_en }]
    photo: null,      // compressed Blob
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
    loadFaceDetector().catch(() => {});   // ready before the student opens the camera

    if (!state.activity) {
      renderProgress($('welcome-progress'));
      return show('welcome');
    }

    const record = recordWith(state.activity.profesor_id);
    if (record) return showDone(record, false);
    if (!state.activity.activa) return showClosed();
    showPhotoScreen();
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

  function showPhotoScreen(message) {
    resetPhoto();
    $('photo-name').textContent = state.student.nombre.split(' ')[0];
    renderProgress($('photo-progress'));
    show('photo');
    if (message) setAlert('photo-error', message);
  }

  // The selfie is ready: show it with "Check in" and "Retake selfie".
  function showPreview(blob, activity) {
    setActivity(activity);
    if (!state.student) return showRegister();
    resetPhoto();
    state.photo = blob;
    const preview = $('photo-preview');
    preview.src = URL.createObjectURL(blob);
    preview.hidden = false;
    $('photo-empty').hidden = true;
    $('btn-take').hidden = true;
    $('btn-submit').hidden = false;
    $('btn-retake').hidden = false;
    $('photo-name').textContent = state.student.nombre.split(' ')[0];
    renderProgress($('photo-progress'));
    show('photo');
  }

  // On an activity's screen, the selfie must show that activity's QR code.
  $('btn-take').addEventListener('click', () => openCamera(state.activity));
  $('btn-retake').addEventListener('click', () => openCamera(state.activity));

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
  async function compressImage(source, sourceWidth, sourceHeight) {
    const scale = Math.min(1, PHOTO_MAX_SIDE / Math.max(sourceWidth, sourceHeight));
    let width = Math.round(sourceWidth * scale);
    let height = Math.round(sourceHeight * scale);
    let quality = 0.8;
    const canvas = document.createElement('canvas');
    let blob = null;

    for (let attempt = 0; attempt < 10; attempt++) {
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, width, height);
      ctx.drawImage(source, 0, 0, width, height);
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
      // The teacher switched to another activity while the student was taking the photo.
      if (/activity_inactive/.test(err.message || '')) return goToMain();
      console.error(err);
      setAlert('photo-error', friendlyError(err));
    } finally {
      setBusy(button, false);
      $('btn-retake').disabled = false;
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
    $('done-next').textContent = 'In your next classroom, tap "Next activity" and take a selfie with its QR code behind you.';
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

  // ---------------------------------------------------------------- selfie camera
  // Front camera with a crown filter. The crown (and "Take photo") appears
  // when we see the student's face and a valid classroom QR code; the code
  // also tells which activity the check-in is for.
  const cam = {
    stream: null,
    frame: 0,             // requestAnimationFrame id
    qrTimer: null,
    readQr: null,         // async (image) => text or null
    expected: null,       // the activity the student is in, or null when the QR code picks it ("Next activity")
    detector: null,       // MediaPipe face detector, once loaded
    faceless: false,      // the face detector couldn't load: the crown goes on top, without tracking
    face: null,           // smoothed { x, y, size, angle } in video pixels
    faceAt: 0,
    qr: null,             // { activity, at } last valid code seen
    problem: '',          // why the last code seen isn't valid
    problemAt: 0,
    side: 1,              // the crown leans to the right (1) or left (-1)
    openedAt: 0,
    ready: false,
    canvas: document.createElement('canvas'),   // for reading the QR with jsQR
  };

  const crownImg = new Image();
  crownImg.src = 'crown.png';

  function cameraMessage(text, isError) {
    if ($('camera-msg').textContent !== text) $('camera-msg').textContent = text;
    $('camera-msg').classList.toggle('is-error', !!isError);
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
      cam.canvas.width = w;
      cam.canvas.height = h;
      const ctx = cam.canvas.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(source, 0, 0, w, h);
      const code = window.jsQR(ctx.getImageData(0, 0, w, h).data, w, h, { inversionAttempts: 'dontInvert' });
      return code ? code.data : null;
    };
  }

  // Loaded once, as soon as the student may need it (the files are cached afterwards).
  let faceDetectorPromise = null;
  function loadFaceDetector() {
    if (!faceDetectorPromise) {
      faceDetectorPromise = (async () => {
        const vision = await import(`${MEDIAPIPE_URL}/vision_bundle.mjs`);
        const files = await vision.FilesetResolver.forVisionTasks(`${MEDIAPIPE_URL}/wasm`);
        // The CPU is fast enough for this small model and works on every phone.
        return vision.FaceDetector.createFromOptions(files, {
          baseOptions: { modelAssetPath: FACE_MODEL_URL, delegate: 'CPU' },
          runningMode: 'VIDEO',
          minDetectionConfidence: 0.5,
        });
      })();
      faceDetectorPromise.catch((err) => {
        console.error(err);
        faceDetectorPromise = null;   // try again next time
      });
    }
    return faceDetectorPromise;
  }

  // Eyes and size of the biggest face, in pixels of the image.
  function facePose(source, width, height) {
    let result;
    try {
      result = cam.detector.detectForVideo(source, performance.now());
    } catch (err) {
      console.error(err);
      return null;
    }
    const faces = (result && result.detections) || [];
    if (!faces.length) return null;
    const face = faces.reduce((a, b) => (b.boundingBox.width > a.boundingBox.width ? b : a));
    const k = face.keypoints || [];
    if (k.length < 2) return null;
    // The eye on the left of the image first, so an upright face has angle 0.
    const [a, b] = [k[0], k[1]].sort((p, q) => p.x - q.x);
    const ax = a.x * width;
    const ay = a.y * height;
    const bx = b.x * width;
    const by = b.y * height;
    return { x: (ax + bx) / 2, y: (ay + by) / 2, size: face.boundingBox.width, angle: Math.atan2(by - ay, bx - ax) };
  }

  // Follows the face smoothly, so the crown doesn't shake.
  function trackFace(video) {
    if (!cam.detector) return;
    const pose = facePose(video, video.videoWidth, video.videoHeight);
    if (!pose) {
      if (Date.now() - cam.faceAt > 400) cam.face = null;
      return;
    }
    const f = cam.face;
    const mix = (from, to) => from + (to - from) * 0.45;
    cam.face = f ? {
      x: mix(f.x, pose.x), y: mix(f.y, pose.y), size: mix(f.size, pose.size), angle: mix(f.angle, pose.angle),
    } : pose;
    cam.faceAt = Date.now();
  }

  // Where the crown goes: above the forehead, leaning to one side.
  function crownPose(face, width, height) {
    if (!face) {
      return { x: width / 2 + cam.side * width * 0.18, y: height * 0.24, width: width * 0.36, angle: cam.side * CROWN_TILT };
    }
    const ux = Math.cos(face.angle);   // along the eyes
    const uy = Math.sin(face.angle);
    const upX = uy;                    // towards the top of the head
    const upY = -ux;
    return {
      x: face.x + upX * face.size * 0.7 + ux * cam.side * face.size * 0.3,
      y: face.y + upY * face.size * 0.7 + uy * cam.side * face.size * 0.3,
      width: face.size * 1.05,
      angle: face.angle + cam.side * CROWN_TILT,
    };
  }

  function drawCrown(ctx, pose) {
    const height = pose.width * (crownImg.naturalHeight / crownImg.naturalWidth);
    ctx.save();
    ctx.translate(pose.x, pose.y);
    ctx.rotate(pose.angle);
    ctx.drawImage(crownImg, -pose.width / 2, -height * 0.9, pose.width, height);   // the band sits on the head
    ctx.restore();
  }

  // Activity name and the student's group, then the student and time, at the bottom of the photo.
  function drawStamp(ctx, width, height, activity) {
    const student = state.student;
    const group = student ? groupName(teacherById(student.profesor_id), student.grupo || 1) : '';
    const pad = Math.round(width * 0.03);
    const big = Math.round(width * 0.042);
    const small = Math.round(width * 0.032);
    const band = pad * 2.5 + big + small;
    const now = new Date();
    ctx.fillStyle = 'rgba(4, 80, 40, 0.78)';
    ctx.fillRect(0, height - band, width, band);
    ctx.fillStyle = '#fff';
    ctx.textBaseline = 'top';
    ctx.font = `bold ${big}px Arial, Helvetica, sans-serif`;
    ctx.fillText(`👑 ${activity.nombre}${group ? ` · ${group}` : ''}`, pad, height - band + pad, width - pad * 2);
    ctx.font = `${small}px Arial, Helvetica, sans-serif`;
    ctx.fillText(`${student ? student.nombre : ''} · ${formatDate(now)}, ${formatTime(now)}`,
      pad, height - band + pad * 1.5 + big, width - pad * 2);
  }

  // Is this QR code a classroom where the student can check in now?
  function checkCode(text) {
    let id = '';
    try {
      const url = new URL(text, location.href);
      id = (url.searchParams.get('activity') || url.searchParams.get('actividad') || '').trim().toLowerCase();
    } catch { /* not a URL */ }
    const activity = activityById(id);
    if (!activity) return { error: "That QR code isn't from the Activity Rotation." };
    // Inside an activity, only its own QR code counts.
    if (cam.expected && activity.id !== cam.expected.id) {
      return { error: `That's the QR code of ${activity.nombre}. Show the one for ${cam.expected.nombre}.` };
    }
    if (state.student && recordWith(activity.profesor_id)) {
      const teacher = teacherById(activity.profesor_id);
      return { error: `You already did ${teacher ? `${teacher.nombre}'s` : 'this teacher\'s'} activity.` };
    }
    if (!activity.activa) return { error: `${activity.nombre} isn't open right now.` };
    return { activity };
  }

  function isReady() {
    const qrOk = cam.qr && Date.now() - cam.qr.at < QR_GRACE_MS;
    return !!(qrOk && (cam.face || cam.faceless) && crownImg.complete && crownImg.naturalWidth);
  }

  function updateCameraState(ready) {
    const now = Date.now();
    if (ready) cameraMessage('Ready! Take your photo 👑');
    else if (!cam.detector && !cam.faceless) cameraMessage('Loading the crown filter…');
    else if (!cam.face && !cam.faceless) cameraMessage("We can't see your face. Look at the screen.");
    else if (cam.problem && now - cam.problemAt < QR_GRACE_MS) cameraMessage(cam.problem, true);
    else if (now - cam.openedAt > 8000) cameraMessage('Move closer to the QR code and look for more light.');
    else cameraMessage("Now show the classroom's QR code behind you.");
    if (ready && !cam.ready && navigator.vibrate) navigator.vibrate(60);
    cam.ready = ready;
    $('camera-shoot').disabled = !ready;
  }

  // Draws the mirrored video (like a selfie) with the crown, every frame.
  function drawFrame() {
    if ($('camera').hidden || !cam.stream) return;
    const video = $('camera-video');
    const w = video.videoWidth;
    const h = video.videoHeight;
    if (video.readyState >= 2 && w && h) {
      const canvas = $('camera-canvas');
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
      }
      trackFace(video);
      const ready = isReady();
      const ctx = canvas.getContext('2d');
      ctx.save();
      ctx.translate(w, 0);
      ctx.scale(-1, 1);
      ctx.drawImage(video, 0, 0, w, h);
      if (ready) drawCrown(ctx, crownPose(cam.face, w, h));
      ctx.restore();
      updateCameraState(ready);
    }
    cam.frame = requestAnimationFrame(drawFrame);
  }

  function scanLoop() {
    cam.qrTimer = setTimeout(async () => {
      if ($('camera').hidden || !cam.stream) return;
      const video = $('camera-video');
      if (video.readyState >= 2) {
        let text = null;
        try { text = await cam.readQr(video); } catch (err) { console.error(err); }
        if (text) {
          const result = checkCode(text);
          if (result.activity) {
            cam.qr = { activity: result.activity, at: Date.now() };
            cam.problem = '';
          } else {
            cam.problem = result.error;
            cam.problemAt = Date.now();
          }
        }
      }
      scanLoop();
    }, 250);
  }

  function useFaceDetector() {
    cam.detector = null;
    cam.faceless = false;
    const timer = setTimeout(() => { if (!cam.detector) cam.faceless = true; }, 20000);
    loadFaceDetector()
      .then((detector) => { cam.detector = detector; cam.faceless = false; })
      .catch(() => { cam.faceless = true; })
      .finally(() => clearTimeout(timer));
  }

  function cameraFailed(message) {
    cameraMessage(message, true);
    $('camera-fallback').hidden = false;
  }

  async function openCamera(expected) {
    cam.expected = expected || null;
    $('camera').hidden = false;
    document.body.style.overflow = 'hidden';
    Object.assign(cam, { face: null, qr: null, problem: '', ready: false, openedAt: Date.now() });
    cam.side = Math.random() < 0.5 ? -1 : 1;
    $('camera-shoot').disabled = true;
    $('camera-fallback').hidden = true;
    cameraMessage('Starting camera…');
    loadLists().catch((err) => console.error(err));   // so newly added or switched activities are recognized
    useFaceDetector();

    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      return cameraFailed("This browser can't open the camera here. Use your phone's camera app instead.");
    }
    try {
      cam.stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'user', width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: false,
      });
    } catch (err) {
      console.error(err);
      const denied = err && /NotAllowed|Permission/i.test(err.name || err.message);
      return cameraFailed(denied
        ? 'Camera access was blocked. Allow the camera for this site in your browser settings, or use your camera app.'
        : "We couldn't open the camera. Close other apps using it and try again.");
    }

    // The camera may have been closed while waiting for permission.
    if ($('camera').hidden) return stopCamera();

    const video = $('camera-video');
    video.srcObject = cam.stream;
    try { await video.play(); } catch { /* autoplay attribute handles it */ }

    try {
      cam.readQr = await getQrReader();
    } catch (err) {
      console.error(err);
      return cameraFailed(friendlyError(err));
    }
    cam.frame = requestAnimationFrame(drawFrame);
    scanLoop();
  }

  function stopCamera() {
    cancelAnimationFrame(cam.frame);
    clearTimeout(cam.qrTimer);
    if (cam.stream) cam.stream.getTracks().forEach((t) => t.stop());
    cam.stream = null;
    $('camera-video').srcObject = null;
  }

  function closeCamera() {
    stopCamera();
    $('camera').hidden = true;
    document.body.style.overflow = '';
  }

  // The photo keeps the real orientation (not mirrored), so the QR code reads normally.
  $('camera-shoot').addEventListener('click', async () => {
    if (!isReady()) return;
    const button = $('camera-shoot');
    button.disabled = true;
    const video = $('camera-video');
    const activity = cam.qr.activity;
    const w = video.videoWidth;
    const h = video.videoHeight;
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(video, 0, 0, w, h);
    drawCrown(ctx, crownPose(cam.face, w, h));
    drawStamp(ctx, w, h, activity);
    try {
      const blob = await compressImage(canvas, w, h);
      closeCamera();
      showPreview(blob, activity);
    } catch (err) {
      console.error(err);
      cameraMessage("We couldn't save that photo. Please try again.", true);
      button.disabled = false;
    }
  });

  // Without the live camera: a photo from the phone's camera app, checked the same way.
  $('camera-fallback').addEventListener('click', () => {
    closeCamera();
    $('photo-input').click();
  });

  $('photo-input').addEventListener('change', async (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    e.target.value = '';
    try {
      const img = await loadImage(file);
      const w = img.naturalWidth;
      const h = img.naturalHeight;
      const text = await (await getQrReader())(img);
      const result = text ? checkCode(text) : { error: "We couldn't see the classroom's QR code in your photo. Take it again closer to the code." };
      if (!result.activity) {
        if (!state.student) return showRegister();
        return showPhotoScreen(result.error);
      }
      try {
        const detector = await loadFaceDetector();
        cam.detector = detector;
      } catch { /* the crown goes on top */ }
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, w, h);
      cam.side = Math.random() < 0.5 ? -1 : 1;
      drawCrown(ctx, crownPose(cam.detector ? facePose(img, w, h) : null, w, h));
      drawStamp(ctx, w, h, result.activity);
      showPreview(await compressImage(canvas, w, h), result.activity);
    } catch (err) {
      console.error(err);
      setAlert('photo-error', "We couldn't read that photo. Please take it again.");
    }
  });

  // "Next activity" and similar: the QR code in the selfie picks the activity.
  document.querySelectorAll('[data-scan]').forEach((b) => b.addEventListener('click', () => openCamera(null)));
  $('camera-close').addEventListener('click', closeCamera);
  $('camera-cancel').addEventListener('click', closeCamera);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('camera').hidden) closeCamera(); });
  document.addEventListener('visibilitychange', () => { if (document.hidden && !$('camera').hidden) closeCamera(); });

  // ---------------------------------------------------------------- start
  fillBranding();
  init();
})();
