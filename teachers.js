// Teacher dashboard.
(function () {
  const { createDb, formatDate, formatTime, formatDateTimePlain, escapeHtml, friendlyError,
    storageGet, storageSet, fillBranding, cfg } = window.App;

  const db = createDb();
  const PDF_LIBS = [
    'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js',
    'https://cdnjs.cloudflare.com/ajax/libs/jspdf-autotable/3.8.2/jspdf.plugin.autotable.min.js',
  ];
  const ACTIVITY_KEY = 'rotation.teacher.activity';
  const PAGE_SIZE = 1000;

  const state = {
    activities: [],
    students: [],
    attendance: [],
    byStudent: new Map(),   // codigo -> Map(actividad_id -> attendance)
    photoUrls: new Map(),   // foto_path -> signed URL
    tab: 'activity',
    email: '',
    myActivity: null,       // activity assigned to the signed-in teacher
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
      const [activities, students, attendance] = await Promise.all([
        fetchAll('actividades', 'id, nombre, salon, profesor, orden', 'orden'),
        fetchAll('estudiantes', 'codigo, nombre, grado, creado_en', 'codigo'),
        fetchAll('asistencias', 'id, estudiante_codigo, actividad_id, registrado_en, foto_path', 'id'),
      ]);
      // Which activity belongs to this teacher (optional).
      const mine = await db.from('profesores').select('actividad_id').eq('email', state.email).maybeSingle();
      state.myActivity = (!mine.error && mine.data && mine.data.actividad_id) || null;

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
    const current = select.value || state.myActivity || storageGet(ACTIVITY_KEY);
    select.innerHTML = activityOptions();
    if (state.activities.some((a) => a.id === current)) select.value = current;
  }

  function activityOptions() {
    return state.activities.map((a) => {
      const mine = a.id === state.myActivity ? ' (your activity)' : '';
      return `<option value="${escapeHtml(a.id)}">${escapeHtml(a.nombre)} – ${escapeHtml(a.salon)}${mine}</option>`;
    }).join('');
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

  function attendanceOf(activity) {
    return state.attendance
      .filter((a) => a.actividad_id === activity.id)
      .sort((x, y) => new Date(x.registrado_en) - new Date(y.registrado_en));
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

  function attendanceTable(doc, y, activity, thumbs) {
    const records = attendanceOf(activity);
    if (!records.length) return emptyNote(doc, y, 'No check-ins yet for this activity.');

    const withPhotos = !!thumbs;
    const head = ['#', ...(withPhotos ? ['Photo'] : []), 'Student', 'Student ID', 'Course / Group', 'Date', 'Time'];
    const body = records.map((r, i) => {
      const s = studentByCode(r.estudiante_codigo);
      return [String(i + 1), ...(withPhotos ? [''] : []), s.nombre, s.codigo, s.grado,
        formatDate(r.registrado_en), formatTime(r.registrado_en)].map(pdfText);
    });

    doc.autoTable(tableOptions({
      startY: y,
      head: [head],
      body,
      columnStyles: withPhotos
        ? { 0: { cellWidth: 24, halign: 'center', textColor: C.text2 }, 1: { cellWidth: THUMB + 10, minCellHeight: THUMB + 10 }, 2: { fontStyle: 'bold' } }
        : { 0: { cellWidth: 24, halign: 'center', textColor: C.text2 }, 1: { fontStyle: 'bold' } },
      didDrawCell: (data) => {
        if (!withPhotos || data.section !== 'body' || data.column.index !== 1) return;
        const img = thumbs.get(records[data.row.index].foto_path);
        if (img) {
          doc.addImage(img, 'JPEG', data.cell.x + 5, data.cell.y + (data.cell.height - THUMB) / 2, THUMB, THUMB);
        }
      },
    }));
    return doc.lastAutoTable.finalY + 22;
  }

  function missingTable(doc, y, activity) {
    const attended = new Set(attendanceOf(activity).map((r) => r.estudiante_codigo));
    const missing = state.students.filter((s) => !attended.has(s.codigo));
    y = sectionHeading(doc, y, 'Not checked in yet', `${missing.length} of ${state.students.length} registered students`);
    if (!missing.length) return emptyNote(doc, y, 'Every registered student has checked in to this activity.');

    doc.autoTable(tableOptions({
      startY: y,
      head: [['Student', 'Student ID', 'Course / Group', 'Activities done']],
      body: missing.map((s) => [s.nombre, s.codigo, s.grado, `${completedCount(s.codigo)}/${state.activities.length}`].map(pdfText)),
      headStyles: { fillColor: C.bgAlt, textColor: C.text, fontStyle: 'bold', fontSize: 8 },
    }));
    return doc.lastAutoTable.finalY + 22;
  }

  function overviewTable(doc, y) {
    const total = state.activities.length;
    if (!state.students.length) return emptyNote(doc, y, 'No students registered yet.');
    const firstActivityCol = 3;

    doc.autoTable(tableOptions({
      startY: y,
      head: [['Student', 'ID', 'Course / Group', ...state.activities.map((a) => a.nombre), 'Done', 'Status'].map(pdfText)],
      body: state.students.map((s) => {
        const done = state.byStudent.get(s.codigo) || new Map();
        const count = completedCount(s.codigo);
        return [
          s.nombre, s.codigo, s.grado,
          ...state.activities.map((a) => (done.has(a.id) ? formatTime(done.get(a.id).registrado_en) : '-')),
          `${count}/${total}`, count >= total ? 'Complete' : 'Incomplete',
        ].map(pdfText);
      }),
      styles: {
        font: 'helvetica', fontSize: 8, textColor: C.text, lineColor: C.border, lineWidth: 0.5,
        cellPadding: 4, valign: 'middle', overflow: 'linebreak',
      },
      headStyles: { fillColor: C.ocre, textColor: C.text, fontStyle: 'bold', fontSize: 7, halign: 'center' },
      columnStyles: { 0: { fontStyle: 'bold' } },
      didParseCell: (data) => {
        if (data.section !== 'body') return;
        const col = data.column.index;
        if (col >= firstActivityCol && col < firstActivityCol + total) {
          data.cell.styles.halign = 'center';
          const done = data.cell.raw !== '-';
          data.cell.styles.textColor = done ? C.green : C.faint;
          data.cell.styles.fontStyle = done ? 'bold' : 'normal';
        } else if (col === firstActivityCol + total) {
          data.cell.styles.halign = 'center';
          data.cell.styles.fontStyle = 'bold';
        } else if (col === firstActivityCol + total + 1) {
          const complete = data.cell.raw === 'Complete';
          data.cell.styles.fillColor = complete ? C.greenSoft : C.goldSoft;
          data.cell.styles.textColor = complete ? C.greenDark : C.goldText;
          data.cell.styles.fontStyle = 'bold';
          data.cell.styles.halign = 'center';
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

  function buildActivityReport(doc, activity, thumbs) {
    const records = attendanceOf(activity);
    let y = titleBlock(doc, PAGE.top, 'Attendance report', activity.nombre, [
      `${activity.salon}  |  Teacher: ${activity.profesor}`,
    ]);
    y = statBoxes(doc, y, [
      [records.length, 'Students checked in'],
      [state.students.length - records.length, 'Not checked in yet'],
      [state.students.length, 'Students registered (all activities)'],
    ]);
    y = sectionHeading(doc, y, 'Students who attended', `${records.length} ${records.length === 1 ? 'student' : 'students'}`);
    y = attendanceTable(doc, y, activity, thumbs);
    missingTable(doc, y, activity);
  }

  function buildFullReport(doc, thumbs) {
    const total = state.activities.length;
    const finished = state.students.filter((s) => completedCount(s.codigo) >= total && total > 0).length;
    let y = titleBlock(doc, PAGE.top, 'Attendance report', 'All activities', [
      `${total} activities  |  ${state.students.length} students registered`,
    ]);
    y = statBoxes(doc, y, [
      [state.students.length, 'Students registered'],
      [state.attendance.length, 'Total check-ins'],
      [finished, 'Completed all activities'],
      [state.students.length - finished, 'Still in progress'],
    ]);

    y = sectionHeading(doc, y, 'Activities');
    doc.autoTable(tableOptions({
      startY: y,
      head: [['Activity', 'Room', 'Teacher', 'Check-ins']],
      body: state.activities.map((a) => [a.nombre, a.salon, a.profesor, String(attendanceOf(a).length)].map(pdfText)),
      columnStyles: { 0: { fontStyle: 'bold' }, 3: { halign: 'center' } },
    }));
    y = doc.lastAutoTable.finalY + 22;

    y = sectionHeading(doc, y, "Students' progress", 'Check-in time per activity');
    overviewTable(doc, y);

    state.activities.forEach((activity) => {
      doc.addPage();
      const records = attendanceOf(activity);
      const ay = titleBlock(doc, PAGE.top, 'Activity', activity.nombre, [
        `${activity.salon}  |  Teacher: ${activity.profesor}`,
        `${records.length} ${records.length === 1 ? 'student' : 'students'} checked in`,
      ]);
      attendanceTable(doc, ay, activity, thumbs);
    });
  }

  function fileSafe(text) {
    return pdfText(text).normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '');
  }

  // Dialog
  function openPdfDialog() {
    const select = $('pdf-activity');
    select.innerHTML = activityOptions();
    const preferred = state.myActivity || $('sel-activity').value;
    if (state.activities.some((a) => a.id === preferred)) select.value = preferred;
    $('pdf-activity-label').textContent = state.myActivity ? 'Only my activity' : 'One activity';
    document.querySelector('input[name="pdf-scope"][value="activity"]').checked = true;
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
  $('pdf-activity').addEventListener('change', () => {
    document.querySelector('input[name="pdf-scope"][value="activity"]').checked = true;
  });

  $('pdf-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const scope = document.querySelector('input[name="pdf-scope"]:checked').value;
    const activity = scope === 'activity' ? state.activities.find((a) => a.id === $('pdf-activity').value) : null;
    if (scope === 'activity' && !activity) return setAlert('pdf-error', 'Please choose an activity.');

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
        const records = activity ? attendanceOf(activity) : state.attendance;
        thumbs = await makeThumbnails(records, (done, total) => {
          $('pdf-status').textContent = `Adding photos… ${done} of ${total}`;
        });
      }

      $('pdf-status').textContent = 'Creating the PDF…';
      const doc = new window.jspdf.jsPDF({ unit: 'pt', format: 'letter' });
      doc.setProperties({ title: `${cfg.EVENT_TITLE} - Attendance report`, author: cfg.FOOTER });
      if (activity) buildActivityReport(doc, activity, thumbs); else buildFullReport(doc, thumbs);

      const now = new Date();
      decoratePages(doc, logo, `${formatDate(now)}, ${formatTime(now)}`);
      const day = formatDateTimePlain(now).slice(0, 10);
      doc.save(`${fileSafe(cfg.EVENT_TITLE)}-${activity ? fileSafe(activity.nombre) : 'All-activities'}-${day}.pdf`);

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
