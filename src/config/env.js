const { z } = require('zod');

const originSchema = z.string().refine((value) => {
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && url.origin === value;
  } catch {
    return false;
  }
}, 'Expected an exact HTTP(S) origin without a path');

const envSchema = z.object({
  ENABLE_BOOTSTRAP_ROUTES: z.enum(['true', 'false']).default('false'),
  MONGO_URI: z.string().regex(/^mongodb(?:\+srv)?:\/\/[^\s]+$/, 'Expected a MongoDB connection URI'),
  NODE_ENV: z.enum(['development', 'test', 'staging', 'production']).default('development'),
  PORT: z.string().regex(/^\d+$/).transform(Number).pipe(z.number().int().min(1).max(65535)).prefault('3000'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  ALLOWED_ORIGINS: z.string().default('').transform((value) =>
    value.split(',').map((origin) => origin.trim()).filter(Boolean)
  ).pipe(z.array(originSchema)),
});

function loadConfig(environment = process.env) {
  const result = envSchema.safeParse(environment);
  if (!result.success) {
    // Report field names, never raw environment values.
    const fields = [...new Set(result.error.issues.map((issue) => issue.path[0]))];
    const error = new Error(`Invalid environment configuration: ${fields.join(', ')}`);
    error.code = 'INVALID_CONFIGURATION';
    throw error;
  }
  return Object.freeze({
    nodeEnv: result.data.NODE_ENV,
    mongoUri: result.data.MONGO_URI,
    enableBootstrapRoutes: result.data.ENABLE_BOOTSTRAP_ROUTES === 'true',
    port: result.data.PORT,
    logLevel: result.data.LOG_LEVEL,
    allowedOrigins: Object.freeze([...new Set(result.data.ALLOWED_ORIGINS)]),
  });
}

module.exports = { loadConfig };
