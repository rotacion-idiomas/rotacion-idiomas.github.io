// Teacher sign-up: creates the account, the activity, and links them.
(function () {
  const { createDb, escapeHtml, friendlyError, fillBranding } = window.App;

  const db = createDb();
  const code = (new URLSearchParams(location.search).get('code') || '').trim();

  const $ = (id) => document.getElementById(id);

  function show(name) {
    document.querySelectorAll('.screen').forEach((s) => { s.hidden = s.id !== `s-${name}`; });
    window.scrollTo(0, 0);
  }

  function setAlert(id, message) {
    $(id).hidden = !message;
    $(`${id}-text`).textContent = message || '';
    if (message) $(id).scrollIntoView({ block: 'center', behavior: 'smooth' });
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

  function showInvalid(message, canRetry) {
    if (message) $('invalid-text').textContent = message;
    $('invalid-retry').hidden = !canRetry;
    show('invalid');
  }

  async function init() {
    fillBranding();
    show('loading');
    if (!code) return showInvalid();
    const { data, error } = await db.rpc('invitacion_valida', { p_codigo: code });
    if (error) return showInvalid(friendlyError(error), true);
    if (!data) return showInvalid();
    show('form');
  }
  $('invalid-retry').addEventListener('click', init);

  // Messages for the errors raised by Supabase and by registrar_profesor().
  const MESSAGES = {
    signup_disabled: 'Teacher sign-up is turned off right now. Please contact the event coordinator.',
    weak_password: 'Please choose a stronger password (at least 8 characters).',
    email_address_invalid: 'Please check your email address.',
    validation_failed: 'Please check your email address.',
    already_teacher: 'This email already has a teacher account. Tap "Sign in" below to open your dashboard.',
    invalid_name: 'Please write your full name.',
    invalid_activity: 'Please write the name of your activity (2 to 60 characters).',
    invalid_room: 'The classroom name is too long.',
  };

  function messageFor(error) {
    const key = Object.keys(MESSAGES).find((k) => error.code === k || (error.message || '').includes(k));
    return key ? MESSAGES[key] : friendlyError(error);
  }

  // Creates the login, or signs in if the account exists but wasn't finished.
  async function getSession(email, password) {
    const up = await db.auth.signUp({ email, password });
    if (!up.error) return { session: up.data.session };
    const exists = up.error.code === 'user_already_exists' || /already registered/i.test(up.error.message);
    if (!exists) return { error: messageFor(up.error) };

    const signIn = await db.auth.signInWithPassword({ email, password });
    if (signIn.error) {
      return { error: 'This email already has an account. If it\'s yours, use the same password you chose before, or use a different email.' };
    }
    return { session: signIn.data.session };
  }

  $('signup-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const nombre = $('t-name').value.trim().replace(/\s+/g, ' ');
    const email = $('t-email').value.trim().toLowerCase();
    const actividad = $('t-activity').value.trim().replace(/\s+/g, ' ');
    const salon = $('t-room').value.trim().replace(/\s+/g, ' ');
    const password = $('t-password').value;

    if (nombre.length < 3 || !nombre.includes(' ')) return setAlert('form-error', 'Please write your full name (first and last name).');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return setAlert('form-error', 'Please check your email address.');
    if (actividad.length < 2) return setAlert('form-error', 'Please write the name of your activity.');
    if (password.length < 8) return setAlert('form-error', 'Your password must have at least 8 characters.');
    if (password !== $('t-password2').value) return setAlert('form-error', "The two passwords don't match.");
    setAlert('form-error', '');

    const button = e.submitter || e.target.querySelector('button[type="submit"]');
    setBusy(button, true, 'Creating account…');
    try {
      const result = await getSession(email, password);
      if (result.error) return setAlert('form-error', result.error);
      if (!result.session) {
        return setAlert('form-error', 'Your account needs to be confirmed by email before it can be used. Please contact the event coordinator.');
      }

      const { data, error } = await db.rpc('registrar_profesor', {
        p_codigo: code, p_nombre: nombre, p_actividad: actividad, p_salon: salon,
      });
      if (error) {
        if ((error.message || '').includes('invalid_code')) return showInvalid();
        return setAlert('form-error', messageFor(error));
      }

      $('done-text').textContent = `${data.actividad}${data.salon ? ` (${data.salon})` : ''} is now part of the rotation, with ${data.profesor} as its teacher.`;
      $('done-qr').href = `qr.html?activity=${encodeURIComponent(data.actividad_id)}`;
      show('done');
    } catch (err) {
      console.error(err);
      setAlert('form-error', friendlyError(err));
    } finally {
      setBusy(button, false);
    }
  });

  init();
})();
