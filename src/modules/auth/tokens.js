const jwt = require('jsonwebtoken');
const { randomBytes, createHash } = require('node:crypto');
function freshRefreshToken() { return randomBytes(32).toString('base64url'); }
function digestToken(token) { return createHash('sha256').update(token).digest('hex'); }
function issueAccessToken(userId, sessionId, config) {
  return jwt.sign({ sid: String(sessionId) }, config.jwtAccessSecret, {
    algorithm: 'HS256', subject: String(userId), issuer: config.jwtIssuer,
    audience: config.jwtAudience, expiresIn: config.accessTokenTtl,
  });
}
function verifyAccessToken(token, config, { allowExpired = false } = {}) {
  const claims = jwt.verify(token, config.jwtAccessSecret, {
    algorithms: ['HS256'], issuer: config.jwtIssuer, audience: config.jwtAudience,
    // Expired, signed JWTs may identify a session for revocation only.
    ignoreExpiration: allowExpired,
  });
  if (!claims || typeof claims !== 'object' || typeof claims.sub !== 'string'
    || typeof claims.sid !== 'string' || !/^[a-fA-F0-9]{24}$/.test(claims.sub)
    || !/^[a-fA-F0-9]{24}$/.test(claims.sid) || !Number.isInteger(claims.exp)
    || !Number.isInteger(claims.iat)) throw new Error('Invalid access claims.');
  return claims;
}
module.exports = { freshRefreshToken, digestToken, issueAccessToken, verifyAccessToken };
