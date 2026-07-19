import fs from 'node:fs';
import mysql from 'mysql2/promise';
import { env } from './env.js';

export function buildSslOptions() {
  if (!env.dbSsl) return undefined;

  return {
    minVersion: 'TLSv1.2',
    rejectUnauthorized: true,
    ...(env.dbCaPath ? { ca: fs.readFileSync(env.dbCaPath, 'utf8') } : {}),
  };
}

export function buildConnectionOptions({ includeDatabase = true } = {}) {
  return {
    host: env.dbHost,
    port: env.dbPort,
    ...(includeDatabase ? { database: env.dbName } : {}),
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

export const pool = mysql.createPool({
  ...buildConnectionOptions(),
  waitForConnections: true,
  connectionLimit: env.dbPoolLimit,
  maxIdle: env.dbPoolLimit,
  idleTimeout: 60000,
  queueLimit: 0,
  namedPlaceholders: true,
});

export async function assertDatabaseConnection() {
  const connection = await pool.getConnection();
  try {
    await connection.ping();
    const [[info]] = await connection.query(
      'SELECT DATABASE() AS databaseName, VERSION() AS databaseVersion',
    );
    return info;
  } finally {
    connection.release();
  }
}
