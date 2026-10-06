const pino = require('pino');

function createLogger(config, destination) {
  return pino({
    level: config.logLevel,
    base: { service: 'gym-management-api', environment: config.nodeEnv },
    redact: {
      paths: [
        'req.headers.authorization', 'req.headers.cookie', 'res.headers["set-cookie"]',
        'authorization', 'cookie', 'password', 'passwordHash', 'token',
        'accessToken', 'refreshToken', 'credentials', 'secret', 'mongoUri', 'MONGO_URI', 'uri',
        '*.authorization', '*.cookie', '*.password', '*.passwordHash', '*.token',
        '*.accessToken', '*.refreshToken', '*.credentials', '*.secret',
        '*.mongoUri', '*.MONGO_URI', '*.uri',
        'jwtAccessSecret', 'JWT_ACCESS_SECRET', '*.jwtAccessSecret', '*.JWT_ACCESS_SECRET',
        'tokenHash', 'currentTokenHash', '*.tokenHash', '*.currentTokenHash',
      ],
      censor: '[REDACTED]',
    },
    serializers: {
      // Error messages/stacks may contain request data or credentials.
      err: (error) => ({ type: error.name, code: error.code, status: error.status }),
    },
  }, destination);
}

module.exports = { createLogger };
