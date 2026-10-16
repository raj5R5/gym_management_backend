const { z } = require('zod');

const originSchema = z.string().refine((value) => {
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && url.origin === value;
  } catch {
    return false;
  }
}, 'Expected an exact HTTP(S) origin without a path');

const seconds = (fallback, max) => z.string().regex(/^\d+$/).transform(Number)
  .pipe(z.number().int().min(1).max(max)).prefault(String(fallback));

// Encoding/shape checks reject common mistakes; randomness must come from a CSPRNG.
function strongSigningSecret(value) {
  if (!/^(?:[a-fA-F0-9]{2}){32,64}$/.test(value)) return false;
  const bytes = Buffer.from(value, 'hex');
  const counts = new Map();
  for (const byte of bytes) counts.set(byte, (counts.get(byte) || 0) + 1);
  if (counts.size < 16 || Math.max(...counts.values()) > bytes.length / 4) return false;
  if (/^(.{1,64})\1+$/i.test(value)) return false;
  if (/secret|change.?me|replace|placeholder|default|password|example/i.test(bytes.toString('utf8'))) return false;
  const step = (bytes[1] - bytes[0] + 256) % 256;
  return !bytes.every((byte, index) => !index || (byte - bytes[index - 1] + 256) % 256 === step);
}

const envSchema = z.object({
  CLOUDINARY_CLOUD_NAME: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/).optional().or(z.literal('')),
  CLOUDINARY_API_KEY: z.string().regex(/^[0-9]{1,100}$/).optional().or(z.literal('')),
  CLOUDINARY_API_SECRET: z.string().min(10).max(256).optional().or(z.literal('')),
  JWT_ACCESS_SECRET: z.string().refine(strongSigningSecret),
  JWT_ISSUER: z.string().trim().min(1).max(200),
  JWT_AUDIENCE: z.string().trim().min(1).max(200),
  ACCESS_TOKEN_TTL_SECONDS: seconds(600, 900),
  REFRESH_TOKEN_TTL_SECONDS: seconds(604800, 2592000),
  SESSION_TTL_SECONDS: seconds(2592000, 7776000),
  ENABLE_BOOTSTRAP_ROUTES: z.enum(['true', 'false']).default('false'),
  MONGO_URI: z.string().regex(/^mongodb(?:\+srv)?:\/\/[^\s]+$/, 'Expected a MongoDB connection URI'),
  NODE_ENV: z.enum(['development', 'test', 'staging', 'production']).default('development'),
  PORT: z.string().regex(/^\d+$/).transform(Number).pipe(z.number().int().min(1).max(65535)).prefault('3000'),
  BOOTSTRAP_PORT: seconds(3002, 65535),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  ALLOWED_ORIGINS: z.string().default('').transform((value) =>
    value.split(',').map((origin) => origin.trim()).filter(Boolean)
  ).pipe(z.array(originSchema)),
}).superRefine((env, context) => {
  const photoKeys = ['CLOUDINARY_CLOUD_NAME', 'CLOUDINARY_API_KEY', 'CLOUDINARY_API_SECRET'];
  if (photoKeys.some((key) => env[key]) && !photoKeys.every((key) => env[key])) {
    context.addIssue({ code: 'custom', path: ['CLOUDINARY_CLOUD_NAME'], message: 'Configure all Cloudinary credentials or leave all empty' });
  }
  if (env.ENABLE_BOOTSTRAP_ROUTES === 'true') {
    if (!['development', 'test'].includes(env.NODE_ENV)) {
      context.addIssue({ code: 'custom', path: ['ENABLE_BOOTSTRAP_ROUTES'], message: 'Bootstrap is local development/test only' });
    }
    if (env.BOOTSTRAP_PORT === env.PORT) {
      context.addIssue({ code: 'custom', path: ['BOOTSTRAP_PORT'], message: 'Bootstrap requires a separate port' });
    }
  }
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
    cloudinary: Object.freeze({ cloudName: result.data.CLOUDINARY_CLOUD_NAME,
      apiKey: result.data.CLOUDINARY_API_KEY, apiSecret: result.data.CLOUDINARY_API_SECRET }),
    jwtAccessSecret: result.data.JWT_ACCESS_SECRET,
    jwtIssuer: result.data.JWT_ISSUER,
    jwtAudience: result.data.JWT_AUDIENCE,
    accessTokenTtl: result.data.ACCESS_TOKEN_TTL_SECONDS,
    refreshTokenTtl: result.data.REFRESH_TOKEN_TTL_SECONDS,
    sessionTtl: result.data.SESSION_TTL_SECONDS,
    nodeEnv: result.data.NODE_ENV,
    mongoUri: result.data.MONGO_URI,
    enableBootstrapRoutes: result.data.ENABLE_BOOTSTRAP_ROUTES === 'true',
    port: result.data.PORT,
    bootstrapPort: result.data.BOOTSTRAP_PORT,
    logLevel: result.data.LOG_LEVEL,
    allowedOrigins: Object.freeze([...new Set(result.data.ALLOWED_ORIGINS)]),
  });
}

module.exports = { loadConfig };
