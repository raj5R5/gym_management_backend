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

function createAccountDeletionRouter(service, authService) {
  const router = Router();
  router.use(noStore);
  router.get('/account-deletion-request', authenticate(authService), validate({ query: emptyQuery }), async (req, res) => {
    res.json({ success: true, data: { request: await service.status(req.auth) }, meta: { requestId: req.id } });
  });
  router.post('/account-deletion-request', authenticate(authService), authLimiter(5), validate({ body }), async (req, res) => {
    const request = await service.request(req.auth, req.validated.body.currentPassword);
    res.status(202).json({ success: true, data: { request }, meta: { requestId: req.id } });
  });
  return router;
}

// A standalone external deletion path: no mobile installation, token, login
// session or third-party script is needed. Passwords never appear in URLs.
function createPublicDeletionRouter(service) {
  const router = Router();
  router.use(noStore);
  const page = (content) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Gym Management · Account deletion</title><link rel="stylesheet" href="/account-deletion/style.css"></head><body><main><h1>Gym Management · Account deletion</h1>${content}</main></body></html>`;
  router.get('/style.css', (_req, res) => res.type('css').send(`
    :root{color-scheme:dark light;font:16px/1.5 system-ui,sans-serif;background:#101213;color:#F4F6F5}
    *{box-sizing:border-box}body{margin:0;padding:24px 16px}main{max-width:560px;margin:24px auto;padding:24px;border:1px solid #454E51;border-radius:12px;background:#1C2022}
    h1{font-size:26px;line-height:1.2}p{overflow-wrap:anywhere}label{display:block}input:not([type=checkbox]){display:block;width:100%;min-height:48px;margin-top:8px;border:1px solid #748182;border-radius:8px;padding:12px;font:inherit;background:#101213;color:inherit}
    input[type=checkbox]{width:24px;height:24px;vertical-align:middle;margin:12px 8px 12px 0}button{min-height:50px;width:100%;border:0;border-radius:8px;padding:12px 16px;background:#D8F343;color:#182003;font:600 16px/1.5 system-ui,sans-serif;cursor:pointer}
    :focus-visible{outline:3px solid #D8F343;outline-offset:3px}
    @media(prefers-color-scheme:light){:root{background:#F1F2EC;color:#182020}main{background:#FFFFFF;border-color:#C6CEC4}input:not([type=checkbox]){background:#FFFFFF;border-color:#78847B}button{background:#48620B;color:#FFFFFF}:focus-visible{outline-color:#48620B}}
  `));
  router.get('/', (_req, res) => res.type('html').send(page(`
    <p>Request deletion of your app account and associated personal data. This saves a request for review; it does not immediately delete your account, gym or financial records.</p>
    <p>The operator must resolve gym ownership and explain any legally required retention before completing deletion. Your account remains usable until the request is processed.</p>
    <form method="post">
      <p><label>Account email <input type="email" name="email" autocomplete="username" maxlength="254" required></label></p>
      <p><label>Current password <input type="password" name="currentPassword" autocomplete="current-password" maxlength="128" required></label></p>
      <p><label><input type="checkbox" name="acknowledgement" value="REQUEST_ACCOUNT_DELETION" required> I request deletion of my account and associated personal data.</label></p>
      <button type="submit">Submit deletion request</button>
    </form>`)));
  router.post('/', authLimiter(5), urlencoded({ extended: false, limit: '4kb' }),
    validate({ body: webBody }), async (req, res) => {
      const receipt = await service.requestFromWeb(req.validated.body.email, req.validated.body.currentPassword);
      // Only server-generated hex IDs/status enter the HTML. No submitted text.
      res.status(202).type('html').send(page(`<h2>Request received</h2><p>Reference: ${receipt.id}</p><p>Your request is saved for review. Account deletion has not been confirmed. Keep this reference for follow-up with the app operator.</p>`));
    });
  return router;
}
module.exports = { createAccountDeletionRouter, createPublicDeletionRouter };
