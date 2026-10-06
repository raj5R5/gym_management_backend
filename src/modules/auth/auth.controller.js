const cookieName = '__Secure-gymRefresh';
const cookieOptions = { httpOnly: true, secure: true, sameSite: 'strict', path: '/api/v1/auth' };
function denied() { const error = new Error('Authentication failed.'); error.code = 'INVALID_AUTHENTICATION'; throw error; }
function createAuthController(service, config) {
  const audit = (req) => ({ logger: req.log, requestId: req.id });
  function checkWebOrigin(req) {
    if (!config.allowedOrigins.includes(req.headers.origin)) {
      const error = new Error('Origin not allowed.'); error.code = 'CORS_ORIGIN_DENIED'; throw error;
    }
  }
  function readCredential(req) {
    const cookie = req.cookies?.[cookieName];
    const body = req.validated.body.refreshToken;
    if (Object.hasOwn(req.cookies || {}, cookieName)) {
      checkWebOrigin(req);
      if (body || typeof cookie !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(cookie)) denied();
      return { raw: cookie, clientType: 'web' };
    }
    if (req.headers.origin || !body) denied();
    return { raw: body, clientType: 'mobile' };
  }
  function sendTokens(req, res, result) {
    const { refreshToken, clientType, refreshExpiresAt, ...data } = result;
    if (clientType === 'web') {
      res.cookie(cookieName, refreshToken, { ...cookieOptions, expires: refreshExpiresAt });
    } else data.refreshToken = refreshToken;
    return res.json({ success: true, data, meta: { requestId: req.id } });
  }
  return {
    async provision(req, res) {
      const data = await service.provision(req.validated.params.userId, req.validated.body.password);
      return res.json({ success: true, data, meta: { requestId: req.id } });
    },
    async login(req, res) {
      const client = req.validated.body.client ?? (req.headers.origin ? 'web' : 'mobile');
      if (client === 'web') checkWebOrigin(req);
      else if (req.headers.origin) denied();
      return sendTokens(req, res, await service.login({ ...req.validated.body, client }, audit(req)));
    },
    async refresh(req, res) {
      const { raw, clientType } = readCredential(req);
      return sendTokens(req, res, await service.refresh(raw, clientType, audit(req)));
    },
    async logout(req, res) {
      const header = req.headers.authorization;
      if (header !== undefined && (typeof header !== 'string' || !/^Bearer [^ ]+$/i.test(header))) denied();
      const hasRefresh = Object.hasOwn(req.cookies || {}, cookieName)
        || req.validated.body.refreshToken !== undefined;
      const refresh = hasRefresh ? readCredential(req) : {};
      await service.logoutCredentials({ ...refresh, bearer: header?.slice(7),
        trustedWebOrigin: config.allowedOrigins.includes(req.headers.origin),
      }, audit(req));
      res.clearCookie(cookieName, cookieOptions);
      return res.json({ success: true, data: { loggedOut: true }, meta: { requestId: req.id } });
    },
    async me(req, res) {
      return res.json({ success: true, data: await service.me(req.auth), meta: { requestId: req.id } });
    },
  };
}
module.exports = { createAuthController };
