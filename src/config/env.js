import 'dotenv/config';

const required = ['DB_HOST', 'DB_NAME', 'DB_USER'];

for (const key of required) {
  if (!process.env[key]) {
    throw new Error(`Falta la variable de entorno ${key}`);
  }
}

export const env = {
  port: Number(process.env.PORT ?? 4000),
  dbHost: process.env.DB_HOST,
  dbPort: Number(process.env.DB_PORT ?? 3306),
  dbName: process.env.DB_NAME,
  dbUser: process.env.DB_USER,
  dbPassword: process.env.DB_PASSWORD ?? '',
  publicBaseUrl: process.env.PUBLIC_BASE_URL ?? 'http://localhost:4000',
  corsOrigin: process.env.CORS_ORIGIN ?? 'http://localhost:5173',
  uploadMaxMb: Number(process.env.UPLOAD_MAX_MB ?? 5),
};
