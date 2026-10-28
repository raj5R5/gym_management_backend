const { Router } = require('express');
const { join } = require('node:path');

// Static public document only. No account, credential, database or write access.
// The bundled document is still a draft: deployment/publication requires approval.
function createPrivacyPolicyRouter() {
  const router = Router();
  const document = join(__dirname, 'privacy-policy.html');
  router.get('/', (_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    res.sendFile(document, { dotfiles: 'deny' }, (error) => {
      if (error) next(error);
    });
  });
  return router;
}
module.exports = { createPrivacyPolicyRouter };
