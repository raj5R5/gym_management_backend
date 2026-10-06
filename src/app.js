const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const pinoHttp = require('pino-http');
const { rateLimit } = require('express-rate-limit');
const { createLogger } = require('./config/logger');
const requestId = require('./middleware/requestId');
const notFound = require('./middleware/notFound');
const errorHandler = require('./middleware/errorHandler');

function createApp({ config, logger = createLogger(config), database } = {}) {
  const app = express();
  app.disable('x-powered-by');
  // No proxy is trusted until the deployment topology is explicitly configured.
  app.set('trust proxy', false);
  app.locals.config = config;
  app.locals.logger = logger;
  app.locals.ready = true;

  app.use(requestId);
  app.use(pinoHttp({
    logger,
    genReqId: (req) => req.id,
    customProps: (req) => ({ requestId: req.id }),
    serializers: {
      // Deliberately omit headers, query strings, bodies, and client addresses.
      req: (req) => ({ id: req.id, method: req.method }),
      res: (res) => ({ statusCode: res.statusCode }),
      err: (error) => ({ type: error.name, code: error.code, status: error.status }),
    },
  }));
  app.use(helmet());
  app.use(cors({
    origin(origin, callback) {
      if (!origin) return callback(null, false);
      if (config.allowedOrigins.includes(origin)) return callback(null, true);
      const error = new Error('Origin is not allowed.');
      error.code = 'CORS_ORIGIN_DENIED';
      return callback(error);
    },
    credentials: false,
    methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Request-ID'],
    exposedHeaders: ['X-Request-ID'],
    maxAge: 600,
  }));
  app.use(rateLimit({
    windowMs: 60 * 1000,
    limit: 100,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    // Operational probes do not share the API client quota.
    skip: (req) => ['GET', 'HEAD'].includes(req.method)
      && ['/health', '/ready'].includes(req.path),
    handler(_req, _res, next) {
      const error = new Error('Rate limit exceeded.');
      error.code = 'RATE_LIMITED';
      next(error);
    },
  }));
  app.use(express.json({ limit: '16kb' }));

  const health = (req, res) => res.json({
    success: true,
    data: { status: 'ok' },
    meta: { requestId: req.id },
  });
  app.get('/health', health);
  app.get('/api/v1/health', health);
  app.get('/ready', (req, res) => {
    const databaseStatus = database?.getStatus() ?? 'disconnected';
    const ready = app.locals.ready && databaseStatus === 'connected';
    return res.status(ready ? 200 : 503).json({
      success: ready,
      data: {
        status: !app.locals.ready ? 'shutting_down' : ready ? 'ready' : 'not_ready',
        checks: {
          application: app.locals.ready ? 'ready' : 'shutting_down',
          database: databaseStatus,
        },
      },
      meta: { requestId: req.id },
    });
  });

  app.use(notFound);
  app.use(errorHandler);
  return app;
}

// Construction is explicit: importing this module validates no environment and opens no sockets.
module.exports = { createApp };
