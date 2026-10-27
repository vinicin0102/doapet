import crypto from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(crypto.scrypt);
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };
export const MIN_PASSWORD_LENGTH = 10;

export async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = await scrypt(password, salt, SCRYPT.keylen, SCRYPT);
  return `scrypt$${SCRYPT.N}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export async function verifyPassword(password, stored) {
  const [alg, n, saltB64, hashB64] = String(stored).split('$');
  if (alg !== 'scrypt') return false;
  const expected = Buffer.from(hashB64, 'base64');
  const actual = await scrypt(password, Buffer.from(saltB64, 'base64'), expected.length, {
    ...SCRYPT,
    N: Number(n),
  });
  return crypto.timingSafeEqual(actual, expected);
}

// Hash usado para gastar o mesmo tempo quando o usuário não existe
// (evita descobrir nomes de administradores pelo tempo de resposta).
let dummyHash;
const getDummyHash = async () => (dummyHash ??= await hashPassword(crypto.randomBytes(16).toString('hex')));

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

export async function createAdmin(db, username, password) {
  username = String(username ?? '').trim();
  if (!/^[a-zA-Z0-9._@-]{3,64}$/.test(username)) {
    throw new Error('Usuário inválido (3 a 64 caracteres: letras, números, . _ @ -).');
  }
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
    throw new Error(`A senha deve ter pelo menos ${MIN_PASSWORD_LENGTH} caracteres.`);
  }
  const rows = await db.query(
    `INSERT INTO admins (username, password_hash, created_at) VALUES ($1, $2, $3)
     ON CONFLICT DO NOTHING RETURNING id`,
    [username, await hashPassword(password), new Date().toISOString()],
  );
  if (rows.length === 0) throw new Error('Este usuário já existe.');
}

export async function countAdmins(db) {
  return Number((await db.one('SELECT COUNT(*) AS n FROM admins')).n);
}

/** Retorna o administrador se usuário e senha conferirem; caso contrário, null. */
export async function authenticate(db, username, password) {
  if (typeof username !== 'string' || typeof password !== 'string' || password.length > 1024) return null;
  const admin = await db.one('SELECT id, username, password_hash FROM admins WHERE lower(username) = lower($1)', [
    username.trim(),
  ]);
  const ok = await verifyPassword(password, admin ? admin.password_hash : await getDummyHash());
  return admin && ok ? { id: Number(admin.id), username: admin.username } : null;
}

export async function createSession(db, adminId, hours) {
  const token = crypto.randomBytes(32).toString('base64url');
  const csrfToken = crypto.randomBytes(32).toString('base64url');
  const now = new Date();
  const expires = new Date(now.getTime() + hours * 3600_000);
  await db.query('DELETE FROM sessions WHERE expires_at < $1', [now.toISOString()]);
  await db.query(
    'INSERT INTO sessions (token_hash, admin_id, csrf_token, created_at, expires_at) VALUES ($1, $2, $3, $4, $5)',
    [sha256(token), adminId, csrfToken, now.toISOString(), expires.toISOString()],
  );
  return { token, csrfToken, expires };
}

export async function getSession(db, token) {
  if (!token) return null;
  const row = await db.one(
    `SELECT s.csrf_token, s.expires_at, a.id AS admin_id, a.username
       FROM sessions s JOIN admins a ON a.id = s.admin_id
      WHERE s.token_hash = $1`,
    [sha256(token)],
  );
  if (!row || row.expires_at < new Date().toISOString()) return null;
  return { adminId: Number(row.admin_id), username: row.username, csrfToken: row.csrf_token };
}

export async function destroySession(db, token) {
  if (token) await db.query('DELETE FROM sessions WHERE token_hash = $1', [sha256(token)]);
}

export function csrfMatches(expected, received) {
  if (typeof received !== 'string' || received.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(received), Buffer.from(expected));
}

/**
 * Limite de tentativas por chave (ex.: "login:<ip>"), guardado no banco para
 * funcionar com várias instâncias do servidor, como na Vercel.
 */
export class RateLimiter {
  constructor(db, { maxAttempts = 5, windowMs = 15 * 60_000 } = {}) {
    this.db = db;
    this.maxAttempts = maxAttempts;
    this.windowMs = windowMs;
  }
  #windowStart() {
    return new Date(Date.now() - this.windowMs).toISOString();
  }
  async isBlocked(key) {
    const row = await this.db.one('SELECT count FROM rate_limits WHERE key = $1 AND first_at >= $2', [
      key,
      this.#windowStart(),
    ]);
    return Boolean(row && row.count >= this.maxAttempts);
  }
  async hit(key) {
    await this.db.query(
      `INSERT INTO rate_limits (key, count, first_at) VALUES ($1, 1, $2)
       ON CONFLICT (key) DO UPDATE SET
         count    = CASE WHEN rate_limits.first_at < $3 THEN 1 ELSE rate_limits.count + 1 END,
         first_at = CASE WHEN rate_limits.first_at < $3 THEN $2 ELSE rate_limits.first_at END`,
      [key, new Date().toISOString(), this.#windowStart()],
    );
  }
  async reset(key) {
    await this.db.query('DELETE FROM rate_limits WHERE key = $1', [key]);
  }
}
