// Teacher dashboard: each teacher sees the students who chose them.
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
    students: [],           // students shown: the ones who chose this teacher
    attendance: [],         // check-ins of those students
    byStudent: new Map(),   // codigo -> Map(actividad_id -> attendance)
    photoUrls: new Map(),   // foto_path -> signed URL
    email: '',
    myActivity: null,       // activity of the signed-in teacher (null = sees everyone)
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
        db.from('profesores').select('actividad_id').eq('email', state.email).maybeSingle(),
      ]);
      state.activities = activities;
      const myId = (!mine.error && mine.data && mine.data.actividad_id) || null;
      state.myActivity = activities.find((a) => a.id === myId) || null;

      const visible = state.myActivity
        ? students.filter((s) => s.profesor_actividad === state.myActivity.id)
        : students;
      state.students = visible.sort((a, b) => a.nombre.localeCompare(b.nombre, 'es'));
      state.byStudent = new Map(state.students.map((s) => [s.codigo, new Map()]));
      state.attendance = attendance.filter((a) => state.byStudent.has(a.estudiante_codigo));
      state.attendance.forEach((a) => state.byStudent.get(a.estudiante_codigo).set(a.actividad_id, a));

      setAlert('dash-error', '');
      $('last-update').textContent = `Last updated: ${formatDate(new Date())}, ${formatTime(new Date())}`;
      renderTeacherInfo();
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

  // The teacher's own activity first (with photo), then the others (check only).
  function otherActivities() {
    return state.activities.filter((a) => a !== state.myActivity);
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
    const activity = state.activities.find((a) => a.id === student.profesor_actividad);
    return activity ? activity.profesor : '';
  }

  function matches(student, query) {
    if (!query) return true;
    const q = query.toLowerCase();
    return student.nombre.toLowerCase().includes(q) || student.codigo.toLowerCase().includes(q);
  }

  function summary() {
    const finished = state.students.filter(isComplete).length;
    const mine = state.myActivity;
    return [
      [state.students.length, mine ? 'My students' : 'Students registered'],
      mine
        ? [state.students.filter((s) => recordOf(s, mine)).length, `Checked in at ${mine.nombre}`]
        : [state.attendance.length, 'Total check-ins'],
      [finished, 'Completed all activities'],
      [state.students.length - finished, 'Still in progress'],
    ];
  }

  // ---------------------------------------------------------------- rendering
  function renderTeacherInfo() {
    const mine = state.myActivity;
    $('teacher-info').innerHTML = mine
      ? `<strong>${escapeHtml(mine.profesor)}</strong> · Your activity: ${escapeHtml(mine.nombre)} – ${escapeHtml(mine.salon)}`
      : 'Your account isn\'t linked to an activity, so you can see <strong>every student</strong>.';
  }

  function render() {
    $('stats').innerHTML = summary().map(([num, label]) =>
      `<div class="stat"><div class="num">${num}</div><div class="label">${escapeHtml(label)}</div></div>`).join('');
    renderTable();
  }

  $('search').addEventListener('input', renderTable);
  $('only-incomplete').addEventListener('change', renderTable);

  function checkCell(record) {
    return record
      ? `<td class="c"><span class="yes" title="${escapeHtml(formatDate(record.registrado_en) + ', ' + formatTime(record.registrado_en))}">✓</span></td>`
      : '<td class="c"><span class="no" title="Not yet">✗</span></td>';
  }

  async function renderTable() {
    const mine = state.myActivity;
    const others = otherActivities();
    const total = state.activities.length;
    const columns = 5 + others.length;

    $('students-head').innerHTML = `<tr>
      <th>Student</th><th>Student ID</th>
      ${mine ? `<th class="mine">${escapeHtml(mine.nombre)} · photo</th>` : '<th>Teacher</th>'}
      ${others.map((a) => `<th class="c">${escapeHtml(a.nombre)}</th>`).join('')}
      <th class="c">Done</th><th>Status</th>
    </tr>`;

    const query = $('search').value.trim();
    const onlyIncomplete = $('only-incomplete').checked;
    const rows = state.students
      .filter((s) => matches(s, query))
      .filter((s) => !onlyIncomplete || !isComplete(s));

    const tbody = $('students-rows');
    if (!rows.length) {
      const empty = !state.students.length
        ? (mine ? 'No students have chosen you as their teacher yet.' : 'No students registered yet.')
        : 'No students match these filters.';
      tbody.innerHTML = `<tr><td colspan="${columns}" class="empty">${empty}</td></tr>`;
      return;
    }

    tbody.innerHTML = rows.map((s) => {
      const complete = isComplete(s);
      let first = `<td>${escapeHtml(teacherOf(s))}</td>`;
      if (mine) {
        const r = recordOf(s, mine);
        first = r
          ? `<td class="mine"><div class="photo-cell">
              <button class="thumb" type="button" data-path="${escapeHtml(r.foto_path)}" aria-label="View photo of ${escapeHtml(s.nombre)}"><img alt="" data-src-path="${escapeHtml(r.foto_path)}"></button>
              <span class="nowrap"><span class="yes">✓</span> ${formatTime(r.registrado_en)}</span>
            </div></td>`
          : '<td class="mine"><span class="no">✗</span> <span class="muted">Not yet</span></td>';
      }
      return `<tr class="${complete ? '' : 'is-incomplete'}">
        <td><strong>${escapeHtml(s.nombre)}</strong></td>
        <td class="nowrap">${escapeHtml(s.codigo)}</td>
        ${first}
        ${others.map((a) => checkCell(recordOf(s, a))).join('')}
        <td class="c nowrap"><strong>${completedCount(s)}/${total}</strong></td>
        <td>${complete
          ? '<span class="badge badge-done">Complete</span>'
          : '<span class="badge badge-pending">Incomplete</span>'}</td>
      </tr>`;
    }).join('');

    // Only the photos of the teacher's own activity are loaded.
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

  // ---------------------------------------------------------------- lightbox
  $('students-rows').addEventListener('click', async (e) => {
    const button = e.target.closest('button.thumb');
    if (!button) return;
    const path = button.dataset.path;
    const record = state.attendance.find((a) => a.foto_path === path);
    const student = state.students.find((s) => s.codigo === record.estudiante_codigo);
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

  // One row per student: own activity (time + photo), the others (Done/Pending), status.
  function progressTable(doc, y, thumbs) {
    if (!state.students.length) {
      return emptyNote(doc, y, state.myActivity
        ? 'No students have chosen you as their teacher yet.' : 'No students registered yet.');
    }
    const mine = state.myActivity;
    const columns = [{ head: '#', kind: 'num', value: (s, i) => String(i + 1) }];
    if (thumbs) columns.push({ head: 'Photo', kind: 'photo', value: () => '' });
    columns.push({ head: 'Student', kind: 'name', value: (s) => s.nombre });
    columns.push({ head: 'ID', kind: 'id', value: (s) => s.codigo });
    if (mine) {
      columns.push({ head: mine.nombre, kind: 'mine', value: (s) => {
        const r = recordOf(s, mine);
        return r ? formatTime(r.registrado_en) : 'Pending';
      } });
    } else {
      columns.push({ head: 'Teacher', kind: 'teacher', value: (s) => teacherOf(s) });
    }
    otherActivities().forEach((a) => {
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
      const r = mine && recordOf(state.students[row], mine);
      return r && thumbs && thumbs.get(r.foto_path);
    };

    doc.autoTable(tableOptions({
      startY: y,
      head: [columns.map((c) => pdfText(c.head))],
      body: state.students.map((s, i) => columns.map((c) => pdfText(c.value(s, i)))),
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

  function buildReport(doc, thumbs) {
    const mine = state.myActivity;
    let y = titleBlock(doc, PAGE.top, mine ? 'Attendance report · My students' : 'Attendance report',
      mine ? mine.profesor : 'All students',
      mine
        ? [`Your activity: ${mine.nombre}  |  ${mine.salon}`,
          `${state.students.length} ${state.students.length === 1 ? 'student' : 'students'} chose you as their teacher`]
        : [`${state.activities.length} activities  |  ${state.students.length} students registered`]);
    y = statBoxes(doc, y, summary());
    y = sectionHeading(doc, y, "Students' progress",
      mine ? `Check-in time at ${mine.nombre}; other activities: done or pending` : 'Done or pending per activity');
    progressTable(doc, y, thumbs);
  }

  function fileSafe(text) {
    return pdfText(text).normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '');
  }

  // Dialog
  function openPdfDialog() {
    const mine = state.myActivity;
    $('pdf-desc').textContent = mine
      ? `Your students: their check-in at ${mine.nombre}, and whether they completed the other activities.`
      : 'Every student and whether they completed each activity.';
    $('pdf-photos-label').hidden = !mine;
    $('pdf-photos-text').textContent = mine ? `Include ${mine.nombre} photo thumbnails` : '';
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
    const mine = state.myActivity;
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
      if (mine && $('pdf-photos').checked) {
        const records = state.students.map((s) => recordOf(s, mine)).filter(Boolean);
        thumbs = await makeThumbnails(records, (done, total) => {
          $('pdf-status').textContent = `Adding photos… ${done} of ${total}`;
        });
      }

      $('pdf-status').textContent = 'Creating the PDF…';
      const doc = new window.jspdf.jsPDF({ unit: 'pt', format: 'letter' });
      doc.setProperties({ title: `${cfg.EVENT_TITLE} - Attendance report`, author: cfg.FOOTER });
      buildReport(doc, thumbs);

      const now = new Date();
      decoratePages(doc, logo, `${formatDate(now)}, ${formatTime(now)}`);
      const day = formatDateTimePlain(now).slice(0, 10);
      doc.save(`${fileSafe(cfg.EVENT_TITLE)}-${mine ? fileSafe(mine.profesor) : 'All-students'}-${day}.pdf`);

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
