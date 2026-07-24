import 'dotenv/config';

const requiredDatabaseVariables = [
  'DB_HOST',
  'DB_NAME',
  'DB_USER',
  'DB_PASSWORD',
];

export const missingDatabaseVariables = requiredDatabaseVariables.filter(
  (key) => !process.env[key]?.trim(),
);

export function assertDatabaseEnvironment() {
  if (missingDatabaseVariables.length > 0) {
    throw new Error(
      `Faltan variables de base de datos: ${missingDatabaseVariables.join(', ')}`,
    );
  }
}

function toBoolean(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;

  return ['1', 'true', 'yes', 'on'].includes(
    String(value).toLowerCase(),
  );
}

export const env = {
  port: Number(process.env.PORT ?? 4000),

  dbHost: process.env.DB_HOST?.trim() || '',
  dbPort: Number(process.env.DB_PORT ?? 4000),
  dbName: process.env.DB_NAME?.trim() || '',
  dbUser: process.env.DB_USER?.trim() || '',
  dbPassword: process.env.DB_PASSWORD ?? '',
  dbSsl: toBoolean(process.env.DB_SSL, true),
  dbCaPath: process.env.DB_CA_PATH?.trim() || null,
  dbPoolLimit: Number(process.env.DB_POOL_LIMIT ?? 3),
  dbConnectTimeoutMs: Number(
    process.env.DB_CONNECT_TIMEOUT_MS ?? 15000,
  ),

  publicBaseUrl:
    process.env.PUBLIC_BASE_URL?.trim() ||
    'http://localhost:4000',

  corsOrigin:
    process.env.CORS_ORIGIN?.trim() ||
    'http://localhost:5173',

  uploadMaxMb: Number(process.env.UPLOAD_MAX_MB ?? 5),

  mediaProxySecret:
    process.env.MEDIA_PROXY_SECRET?.trim() ||
    process.env.DB_PASSWORD ||
    '',
};
