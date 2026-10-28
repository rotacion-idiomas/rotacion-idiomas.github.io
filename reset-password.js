// New password for a teacher, from a single-use link created by the administrator.
(function () {
  const { createDb, escapeHtml, friendlyError, fillBranding } = window.App;

  const db = createDb({ auth: { persistSession: false, autoRefreshToken: false } });
  const code = (new URLSearchParams(location.search).get('code') || '').trim();
  let email = '';

  const $ = (id) => document.getElementById(id);

  function show(name) {
    document.querySelectorAll('.screen').forEach((s) => { s.hidden = s.id !== `s-${name}`; });
    window.scrollTo(0, 0);
  }

  function setAlert(id, message) {
    $(id).hidden = !message;
    $(`${id}-text`).textContent = message || '';
  }

  const INVALID = {
    invalid: ["This link isn't valid", 'Please use the full link you received, or ask the event coordinator for a new one.'],
    used: ['This link was already used', 'Each link works only once. If you need to change your password again, ask the event coordinator for a new link.'],
    expired: ['This link has expired', 'Links work for 48 hours. Please ask the event coordinator for a new one.'],
  };

  function showInvalid(status, message) {
    const [title, text] = INVALID[status] || ['Something went wrong', message];
    $('invalid-title').textContent = title;
    $('invalid-text').textContent = text;
    $('invalid-retry').hidden = !!INVALID[status];
    show('invalid');
  }

  async function init() {
    fillBranding();
    show('loading');
    if (!code) return showInvalid('invalid');
    const { data, error } = await db.rpc('estado_link_contrasena', { p_codigo: code });
    if (error) return showInvalid('error', friendlyError(error));
    if (data.status !== 'ok') return showInvalid(data.status);
    email = data.email;
    $('form-who').innerHTML = `${data.nombre ? `${escapeHtml(data.nombre)} · ` : ''}<strong>${escapeHtml(data.email)}</strong>`;
    show('form');
  }
  $('invalid-retry').addEventListener('click', init);

  $('reset-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const password = $('r-password').value;
    if (password.length < 8) return setAlert('form-error', 'Your password must have at least 8 characters.');
    if (password !== $('r-password2').value) return setAlert('form-error', "The two passwords don't match.");
    setAlert('form-error', '');

    const button = e.submitter || e.target.querySelector('button');
    button.disabled = true;
    const { error } = await db.rpc('cambiar_contrasena_con_link', { p_codigo: code, p_password: password });
    button.disabled = false;
    if (error) {
      const status = ['invalid', 'used', 'expired'].find((s) => (error.message || '').includes(`${s}_link`));
      if (status) return showInvalid(status);
      return setAlert('form-error', friendlyError(error));
    }
    $('done-text').textContent = `You can now sign in with ${email} and your new password.`;
    show('done');
  });

  init();
})();
