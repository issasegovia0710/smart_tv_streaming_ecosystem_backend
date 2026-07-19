import fs from 'node:fs';
import mysql from 'mysql2/promise';

import {
  assertDatabaseEnvironment,
  env,
} from './env.js';

export function buildSslOptions() {
  if (!env.dbSsl) return undefined;

  return {
    minVersion: 'TLSv1.2',
    rejectUnauthorized: true,
    ...(env.dbCaPath
      ? {
          ca: fs.readFileSync(env.dbCaPath, 'utf8'),
        }
      : {}),
  };
}

export function buildConnectionOptions({
  includeDatabase = true,
  validate = true,
} = {}) {
  if (validate) {
    assertDatabaseEnvironment();
  }

  return {
    host: env.dbHost || '127.0.0.1',
    port: env.dbPort,
    ...(includeDatabase && env.dbName
      ? {
          database: env.dbName,
        }
      : {}),
    user: env.dbUser,
    password: env.dbPassword,
    ssl: buildSslOptions(),
    connectTimeout: env.dbConnectTimeoutMs,
    enableKeepAlive: true,
    keepAliveInitialDelay: 0,
    charset: 'utf8mb4',
    timezone: 'Z',
  };
}

// Crear el pool no abre una conexión inmediatamente.
// Esto permite que / y /api/v1/health funcionen aunque Vercel todavía
// no tenga bien configuradas las variables de TiDB.
export const pool = mysql.createPool({
  ...buildConnectionOptions({
    includeDatabase: true,
    validate: false,
  }),
  waitForConnections: true,
  connectionLimit: env.dbPoolLimit,
  maxIdle: env.dbPoolLimit,
  idleTimeout: 60000,
  queueLimit: 0,
  namedPlaceholders: true,
});

export async function assertDatabaseConnection() {
  assertDatabaseEnvironment();

  const connection = await pool.getConnection();

  try {
    await connection.ping();

    const [[info]] = await connection.query(
      `
        SELECT
          DATABASE() AS databaseName,
          VERSION() AS databaseVersion
      `,
    );

    return info;
  } finally {
    connection.release();
  }
}
