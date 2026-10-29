const { Router, urlencoded } = require('express');
const { z } = require('zod');
const authenticate = require('../../middleware/authenticate');
const validate = require('../../middleware/validate');
const { authLimiter } = require('../auth/auth.routes');

const acknowledgement = z.literal('REQUEST_ACCOUNT_DELETION');
const password = z.string().min(1).max(128);
const body = z.strictObject({ currentPassword: password, acknowledgement });
const webBody = z.strictObject({ email: z.string().trim().pipe(z.email().max(254)), currentPassword: password, acknowledgement });
const emptyQuery = z.strictObject({});
function noStore(_req, res, next) { res.setHeader('Cache-Control', 'no-store'); next(); }

const objectIdText = /^[a-f0-9]{24}$/;
const proofText = /^[A-Za-z0-9_-]{43}$/;
const escape = (value) => String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const webMessages = {
  INVALID_CREDENTIALS: 'The email or password is incorrect. Nothing was deleted.',
  DELETION_SCOPE_CHANGED: 'Your account or gym ownership changed. Start again to review the current details.',
  DELETION_SCOPE_INVALID: 'Your gym access changed. Start again to review the current details.',
  DELETION_OWNERSHIP_HANDOFF_REQUIRED: 'A gym you own needs another owner or a selected closure. Start again to review it.',
  DELETION_OTHER_OWNERS_PRESENT: 'Another owner runs a gym selected for closure. Start again to review it.',
  DELETION_PENDING_OPERATIONS: 'A photo upload is still processing. Wait a few minutes, then start again.',
  DELETION_EXISTING_REVIEW_REQUIRED: 'An earlier deletion review for this account must finish first.',
  DELETION_ALREADY_QUEUED: 'Deletion of this account is already confirmed and in progress.',
  DELETION_CONFIRMATION_INVALID: 'This review expired or was replaced. Start again.',
  DELETION_CLOSURE_CONFIRMATION_REQUIRED: 'Tick each gym closure to confirm it, or start again.',
  FORBIDDEN: 'The reference or status code is not valid.',
};
const stateText = {
  queued: 'Confirmed. Deletion has not finished yet.',
  purge: 'Your account is deleted. The closed gym records are being removed.',
  cleanup: 'Your account is deleted. Photo and final cleanup is still in progress.',
  notifying: 'Your account is deleted. The completion email is being sent.',
  completed: 'Deletion is complete.',
  needs_action: 'Stopped before anything was deleted. Your account still works. Start again to review the changes.',
  preview: 'Not confirmed. Nothing has been deleted.',
};

function createAccountDeletionRouter(service, authService, { automated = false } = {}) {
  const router = Router();
  router.use(noStore);
  router.get('/account-deletion-request', authenticate(authService), validate({ query: emptyQuery }), async (req, res) => {
    res.json({ success: true, data: { request: await service.status(req.auth) }, meta: { requestId: req.id } });
  });
  router.post('/account-deletion-request', authenticate(authService), authLimiter(5), validate({ body }), async (req, res) => {
    // With automation on, a request nobody processes would be a misleading receipt.
    if (automated) { const error = new Error('Use the updated deletion flow.'); error.code = 'ACCOUNT_DELETION_UPDATE_REQUIRED'; throw error; }
    const request = await service.request(req.auth, req.validated.body.currentPassword);
    res.status(202).json({ success: true, data: { request }, meta: { requestId: req.id } });
  });
  return router;
}

// A standalone external deletion path: no mobile installation, token, login
// session or third-party script is needed. Passwords never appear in URLs.
function createPublicDeletionRouter(service, engine = null) {
  const router = Router();
  router.use(noStore);
  const page = (content) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>MuscleDesk · Account deletion</title><link rel="stylesheet" href="/account-deletion/style.css"></head><body><main><h1>MuscleDesk · Account deletion</h1>${content}<footer><a href="/privacy-policy">Privacy policy</a><p>Support: <a href="mailto:pcterajbca7772@gmail.com">pcterajbca7772@gmail.com</a></p></footer></main></body></html>`;
  router.get('/style.css', (_req, res) => res.type('css').send(`
    :root{color-scheme:dark light;font:16px/1.5 system-ui,sans-serif;background:#101213;color:#F4F6F5}
    *{box-sizing:border-box}body{margin:0;padding:24px 16px}main{max-width:560px;margin:24px auto;padding:24px;border:1px solid #454E51;border-radius:12px;background:#1C2022}
    h1{font-size:26px;line-height:1.2}h2{font-size:20px;line-height:1.35;margin:0 0 12px}p{overflow-wrap:anywhere}a{color:#D8F343;text-underline-offset:3px;overflow-wrap:anywhere}section,footer{border-top:1px solid #454E51;padding-top:24px;margin-top:24px}footer{font-size:14px}.email-action{display:flex;align-items:center;justify-content:center;min-height:48px;padding:12px 16px;border:1px solid currentColor;border-radius:8px;font-weight:600;text-align:center;text-decoration:none}label{display:block}input:not([type=checkbox]){display:block;width:100%;min-height:48px;margin-top:8px;border:1px solid #748182;border-radius:8px;padding:12px;font:inherit;background:#101213;color:inherit}
    input[type=checkbox]{width:24px;height:24px;vertical-align:middle;margin:12px 8px 12px 0}button{min-height:50px;width:100%;border:0;border-radius:8px;padding:12px 16px;background:#D8F343;color:#182003;font:600 16px/1.5 system-ui,sans-serif;cursor:pointer}
    :focus-visible{outline:3px solid #D8F343;outline-offset:3px}
    @media(max-width:360px){main{padding:16px;margin:8px auto}h1{font-size:24px}}
    @media(prefers-color-scheme:light){:root{background:#F1F2EC;color:#182020}main{background:#FFFFFF;border-color:#C6CEC4}input:not([type=checkbox]){background:#FFFFFF;border-color:#78847B}button{background:#48620B;color:#FFFFFF}a{color:#48620B}section,footer{border-color:#C6CEC4}:focus-visible{outline-color:#48620B}}
  `));
  if (engine) mountAutomatedPages(router, engine, page);
  else router.get('/', (_req, res) => res.type('html').send(page(`
    <p>Request deletion of your MuscleDesk account and associated personal data. This saves a request that the operator reviews and fulfils manually; it does not immediately delete anything, and your account keeps working until deletion is carried out.</p>
    <p>If you are the only owner of a gym, the operator will email your account address to confirm whether to close the gym, which deletes all of its records, or to make a staff member an owner first. Gym records that stay with a gym that continues to operate are kept by that gym without a link to your account. You receive an email when deletion is complete.</p>
    <section aria-labelledby="cannot-log-in">
      <h2 id="cannot-log-in">Cannot log in?</h2>
      <p>You can email a deletion request without signing in or providing your password. Include the email address used for your MuscleDesk account and say that you want to request account deletion.</p>
      <a class="email-action" href="mailto:pcterajbca7772@gmail.com?subject=MuscleDesk%20account%20deletion%20request">Email a deletion request</a>
      <p>Email <a href="mailto:pcterajbca7772@gmail.com">pcterajbca7772@gmail.com</a> if your email app does not open.</p>
      <p>Do not send passwords, recovery codes or identity/payment documents in ordinary email. Ownership must be verified before a request can be fulfilled: the operator replies to the account's email address and acts only after you confirm from it. Sending an email does not automatically delete an account or its records.</p>
    </section>
    <section aria-labelledby="with-password">
      <h2 id="with-password">Request with your current password</h2>
      <p>No app installation or active login session is needed for this form.</p>
    <form method="post" action="/account-deletion">
      <p><label>Account email <input type="email" name="email" autocomplete="username" maxlength="254" required></label></p>
      <p><label>Current password <input type="password" name="currentPassword" autocomplete="current-password" maxlength="128" required></label></p>
      <p><label><input type="checkbox" name="acknowledgement" value="REQUEST_ACCOUNT_DELETION" required> I request deletion of my account and associated personal data.</label></p>
      <button type="submit">Submit deletion request</button>
    </form>
    </section>`)));
  if (!engine) router.post('/', authLimiter(5), urlencoded({ extended: false, limit: '4kb' }),
    validate({ body: webBody }), async (req, res) => {
      const receipt = await service.requestFromWeb(req.validated.body.email, req.validated.body.currentPassword);
      // Only server-generated hex IDs/status enter the HTML. No submitted text.
      res.status(202).type('html').send(page(`<h2>Request received</h2><p>Reference: ${receipt.id}</p><p>Your request is saved for manual review. Account deletion has not been carried out yet; you will receive an email at your account address when it is complete. Keep this reference for follow-up with the app operator.</p>`));
    });
  return router;
}
const credentials = `
      <p><label>Account email <input type="email" name="email" autocomplete="username" maxlength="254" required></label></p>
      <p><label>Current password <input type="password" name="currentPassword" autocomplete="current-password" maxlength="128" required></label></p>`;
const statusForm = (id = '', code = '') => `<section aria-labelledby="check-status"><h2 id="check-status">Check deletion status</h2>
    <form method="post" action="/account-deletion/status">
      <p><label>Reference <input name="id" maxlength="24" value="${escape(id)}" required></label></p>
      <p><label>Status code <input name="statusToken" maxlength="43" value="${escape(code)}" autocomplete="off" required></label></p>
      <button type="submit">Check status</button>
    </form></section>`;
// Self-service deletion without the app. Each step verifies the password again;
// proofs travel only in POST bodies. Every submitted value is escaped before output.
function mountAutomatedPages(router, engine, page) {
  const form = urlencoded({ extended: false, limit: '8kb' });
  const field = (body, name, max) => typeof body?.[name] === 'string' && body[name].length <= max ? body[name] : null;
  async function attempt(res, work) {
    try { return await work(); } catch (error) {
      if (!webMessages[error.code]) throw error;
      return res.status(error.code === 'INVALID_CREDENTIALS' ? 401 : error.code === 'FORBIDDEN' ? 403 : 409).type('html')
        .send(page(`<h2>Not completed</h2><p role="alert">${webMessages[error.code]}</p><p><a href="/account-deletion">Start again</a></p>`));
    }
  }
  const invalid = (res) => res.status(400).type('html').send(page('<h2>Not completed</h2><p role="alert">Fill in every required field.</p><p><a href="/account-deletion">Start again</a></p>'));
  router.get('/', (_req, res) => res.type('html').send(page(`
    <p>Delete your MuscleDesk login account and its personal data. You will see exactly what will be deleted before anything changes, and you must confirm it.</p>
    <p>If you are the only owner of a gym, you can close it, which permanently deletes the gym and all of its records. To transfer ownership to a staff member instead, use More &gt; Request account deletion in the MuscleDesk app.</p>
    <section aria-labelledby="with-password">
      <h2 id="with-password">Review deletion</h2>
      <p>No app installation or active login session is needed. Forgot your password? Use Recover access on the MuscleDesk sign-in screen first.</p>
      <form method="post" action="/account-deletion/review">${credentials}
      <button type="submit">Review what will be deleted</button>
    </form>
    </section>${statusForm()}`)));
  router.post('/review', authLimiter(10), form, async (req, res) => {
    const email = field(req.body, 'email', 254), password = field(req.body, 'currentPassword', 128);
    if (!email || !password) return invalid(res);
    return attempt(res, async () => {
      const preview = await engine.previewFromWeb(email, password);
      const gyms = preview.gyms.map((g) => `<li><strong>${escape(g.gymName)}</strong>: ${escape(g.consequences)}${g.counts
        ? ` <span>(${g.counts.MemberProfile} members, ${g.counts.TrainerProfile} trainers, ${g.counts.Payment} payments at review time.)</span>
        <p><label><input type="checkbox" name="closeGymIds" value="${g.gymId}" required> Permanently close ${escape(g.gymName)} and delete all of its records.</label></p>` : ''}</li>`).join('');
      res.type('html').send(page(`<h2>Confirm deletion</h2>
        <p>${escape(preview.consequences)}</p>${gyms ? `<ul>${gyms}</ul>` : ''}
        <p>This review expires at ${escape(preview.expiresAt)} (UTC).</p>
        <form method="post" action="/account-deletion/confirm">
          <input type="hidden" name="jobId" value="${preview.id}"><input type="hidden" name="token" value="${preview.token}">
          <input type="hidden" name="statusToken" value="${preview.statusToken}"><input type="hidden" name="email" value="${escape(email)}">
          <p><label>Current password <input type="password" name="currentPassword" autocomplete="current-password" maxlength="128" required></label></p>
          <p><label><input type="checkbox" name="acknowledgement" value="DELETE_MY_ACCOUNT" required> I understand this permanently deletes my account and cannot be undone.</label></p>
          <button type="submit">Delete my account</button>
        </form>`));
    });
  });
  router.post('/confirm', authLimiter(10), form, async (req, res) => {
    const email = field(req.body, 'email', 254), password = field(req.body, 'currentPassword', 128);
    const jobId = field(req.body, 'jobId', 24), token = field(req.body, 'token', 43), statusToken = field(req.body, 'statusToken', 43);
    const closeGymIds = [req.body?.closeGymIds ?? []].flat();
    if (!email || !password || !objectIdText.test(jobId ?? '') || !proofText.test(token ?? '') || !proofText.test(statusToken ?? '')
      || req.body?.acknowledgement !== 'DELETE_MY_ACCOUNT' || closeGymIds.length > 50 || closeGymIds.some((id) => !objectIdText.test(id))) return invalid(res);
    return attempt(res, async () => {
      const job = await engine.confirmFromWeb(email, password, jobId, { token, acknowledgement: 'DELETE_MY_ACCOUNT', closeGymIds });
      res.status(202).type('html').send(page(`<h2>Deletion confirmed</h2><p>${stateText[job.state]}</p>
        <p>Reference: ${job.id}</p><p>Status code: <code>${statusToken}</code></p>
        <p>Keep the reference and status code private to check progress after your account is gone. A completion email is sent when deletion finishes.</p>${statusForm(job.id, statusToken)}`));
    });
  });
  router.post('/status', authLimiter(60), form, async (req, res) => {
    const id = field(req.body, 'id', 24), code = field(req.body, 'statusToken', 43);
    if (!objectIdText.test(id ?? '') || !proofText.test(code ?? '')) return invalid(res);
    return attempt(res, async () => {
      const job = await engine.status(id, code);
      res.type('html').send(page(`<h2>Deletion status</h2><p role="status">${stateText[job.state]}</p><p>Reference: ${job.id}</p>
        ${job.completedAt ? `<p>Completed: ${escape(job.completedAt)}</p>` : ''}`));
    });
  });
}
module.exports = { createAccountDeletionRouter, createPublicDeletionRouter };
