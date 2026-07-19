import { pool } from '../src/config/db.js';
import { env } from '../src/config/env.js';

async function main() {
  try {
    const [[info]] = await pool.query(
      'SELECT DATABASE() AS databaseName, VERSION() AS databaseVersion, CURRENT_USER() AS currentUser',
    );
    const [tables] = await pool.query('SHOW TABLES');

    console.log('Conexión TiDB correcta.');
    console.log(`Host: ${env.dbHost}:${env.dbPort}`);
    console.log(`Base: ${info.databaseName}`);
    console.log(`Usuario: ${info.currentUser}`);
    console.log(`Motor: ${info.databaseVersion}`);
    console.log(`Tablas: ${tables.length}`);
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error('Falló la conexión con TiDB:', error.message);
  process.exit(1);
});
