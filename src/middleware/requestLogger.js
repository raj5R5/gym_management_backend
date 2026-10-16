const pinoHttp = require('pino-http');

const SLOW_REQUEST_MS = 1000;
const routePrefix = Symbol('routePrefix');

function routeTemplatePrefix(template) {
  return (req, _res, next) => {
    req[routePrefix] = template;
    next();
  };
}

function routeTemplate(req) {
  // Only use server-declared templates. baseUrl/originalUrl contain actual IDs.
  // Errors before route selection and unknown routes share a fixed safe label.
  if (typeof req.route?.path !== 'string') return 'unmatched';
  const prefix = req[routePrefix] ?? '';
  return prefix && req.route.path === '/' ? prefix : `${prefix}${req.route.path}`;
}

function createRequestLogger(logger) {
  return pinoHttp({
    logger,
    genReqId: (req) => req.id,
    customProps: (req) => ({ requestId: req.id }),
    customLogLevel: (_req, res, error) => {
      if (error || res.err || res.statusCode >= 500) return 'error';
      return Date.now() - res[pinoHttp.startTime] >= SLOW_REQUEST_MS ? 'warn' : 'info';
    },
    customSuccessObject: (req, _res, fields) => ({ ...fields, route: routeTemplate(req) }),
    customErrorObject: (req, _res, _error, fields) => ({ ...fields, route: routeTemplate(req) }),
    serializers: {
      // Deliberately omit headers, URLs, query strings, bodies, and client addresses.
      req: (req) => ({ id: req.id, method: req.method }),
      res: (res) => ({ statusCode: res.statusCode }),
      err: (error) => ({ type: error.name, code: error.code, status: error.status }),
    },
  });
}

module.exports = { createRequestLogger, routeTemplatePrefix };
