import fs from 'node:fs/promises';
import path from 'node:path';
import mysql from 'mysql2/promise';
import { fileURLToPath } from 'node:url';
import { buildConnectionOptions } from '../src/config/db.js';
import { env } from '../src/config/env.js';

const currentFile = fileURLToPath(import.meta.url);
const currentDir = path.dirname(currentFile);
const projectRoot = path.resolve(currentDir, '..', '..');

async function main() {
  const schemaPath = path.join(projectRoot, 'database', 'schema.sql');
  const seedPath = path.join(projectRoot, 'database', 'seed.sql');
  const schemaSql = await fs.readFile(schemaPath, 'utf8');
  const seedSql = await fs.readFile(seedPath, 'utf8');

  const connection = await mysql.createConnection({
    ...buildConnectionOptions({ includeDatabase: false }),
    multipleStatements: true,
  });

  try {
    console.log(`Conectando a TiDB Cloud: ${env.dbHost}:${env.dbPort}`);
    await connection.query(schemaSql);
    await connection.query(seedSql);

    const [[version]] = await connection.query('SELECT VERSION() AS version');
    const [tables] = await connection.query(`SHOW TABLES FROM \`${env.dbName}\``);

    console.log(`Base preparada: ${env.dbName}`);
    console.log(`Motor: ${version.version}`);
    console.log(`Tablas encontradas: ${tables.length}`);
  } finally {
    await connection.end();
  }
}

main().catch((error) => {
  console.error('No fue posible preparar TiDB:', error.message);
  process.exit(1);
});
