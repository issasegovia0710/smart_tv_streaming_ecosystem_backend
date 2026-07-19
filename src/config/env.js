import 'dotenv/config';

const required = ['DB_HOST', 'DB_NAME', 'DB_USER', 'DB_PASSWORD'];

for (const key of required) {
  if (!process.env[key]) {
    throw new Error(`Falta la variable de entorno ${key}`);
  }
}

function toBoolean(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

export const env = {
  port: Number(process.env.PORT ?? 4000),
  dbHost: process.env.DB_HOST,
  dbPort: Number(process.env.DB_PORT ?? 4000),
  dbName: process.env.DB_NAME,
  dbUser: process.env.DB_USER,
  dbPassword: process.env.DB_PASSWORD,
  dbSsl: toBoolean(process.env.DB_SSL, true),
  dbCaPath: process.env.DB_CA_PATH?.trim() || null,
  dbPoolLimit: Number(process.env.DB_POOL_LIMIT ?? 5),
  dbConnectTimeoutMs: Number(process.env.DB_CONNECT_TIMEOUT_MS ?? 15000),
  publicBaseUrl: process.env.PUBLIC_BASE_URL ?? 'http://localhost:4000',
  corsOrigin: process.env.CORS_ORIGIN ?? 'http://localhost:5173',
  uploadMaxMb: Number(process.env.UPLOAD_MAX_MB ?? 5),
};
