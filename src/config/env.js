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
    throw new Error(`Invalid environment configuration: ${fields.join(', ')}`);
  }
  return Object.freeze({
    nodeEnv: result.data.NODE_ENV,
    port: result.data.PORT,
    logLevel: result.data.LOG_LEVEL,
    allowedOrigins: Object.freeze([...new Set(result.data.ALLOWED_ORIGINS)]),
  });
}

module.exports = { loadConfig };
