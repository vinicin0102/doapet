// Cria um administrador do painel.
// Uso: npm run criar-admin -- <usuario>
// A senha é lida da variável ADMIN_PASSWORD ou digitada no terminal.
import readline from 'node:readline/promises';
import { createAdmin } from '../src/auth.js';
import { loadConfig } from '../src/config.js';
import { openDatabase } from '../src/db.js';

const username = process.argv[2];
if (!username) {
  console.error('Uso: npm run criar-admin -- <usuario>');
  process.exit(1);
}

let password = process.env.ADMIN_PASSWORD;
if (!password) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  password = await rl.question('Senha (mínimo 10 caracteres): ');
  rl.close();
}

// Usa DATABASE_URL (produção) ou o banco local de desenvolvimento.
const db = await openDatabase(loadConfig());
try {
  await createAdmin(db, username, password);
  console.log(`Administrador "${username}" criado com sucesso.`);
} catch (err) {
  console.error(err.message);
  process.exitCode = 1;
} finally {
  await db.close();
}
