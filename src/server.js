import { app } from './app.js';
import { assertDatabaseConnection } from './config/db.js';
import { env } from './config/env.js';

async function start() {
  await assertDatabaseConnection();

  app.listen(env.port, '0.0.0.0', () => {
    console.log(`API lista en http://0.0.0.0:${env.port}`);
  });
}

start().catch((error) => {
  console.error('No fue posible iniciar la API:', error);
  process.exit(1);
});
