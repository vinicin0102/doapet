import crypto from 'node:crypto';

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };
export const MIN_PASSWORD_LENGTH = 10;

export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, SCRYPT.keylen, SCRYPT);
  return `scrypt$${SCRYPT.N}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export function verifyPassword(password, stored) {
  const [alg, n, saltB64, hashB64] = String(stored).split('$');
  if (alg !== 'scrypt') return false;
  const expected = Buffer.from(hashB64, 'base64');
  const actual = crypto.scryptSync(password, Buffer.from(saltB64, 'base64'), expected.length, {
    ...SCRYPT,
    N: Number(n),
  });
  return crypto.timingSafeEqual(actual, expected);
}

// Hash usado para gastar o mesmo tempo quando o usuário não existe
// (evita descobrir nomes de administradores pelo tempo de resposta).
const DUMMY_HASH = hashPassword(crypto.randomBytes(16).toString('hex'));

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

export function createAdmin(db, username, password) {
  username = String(username ?? '').trim();
  if (!/^[a-zA-Z0-9._@-]{3,64}$/.test(username)) {
    throw new Error('Usuário inválido (3 a 64 caracteres: letras, números, . _ @ -).');
  }
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
    throw new Error(`A senha deve ter pelo menos ${MIN_PASSWORD_LENGTH} caracteres.`);
  }
  db.prepare('INSERT INTO admins (username, password_hash, created_at) VALUES (?, ?, ?)').run(
    username,
    hashPassword(password),
    new Date().toISOString(),
  );
}

export function countAdmins(db) {
  return db.prepare('SELECT COUNT(*) AS n FROM admins').get().n;
}

/** Retorna o administrador se usuário e senha conferirem; caso contrário, null. */
export function authenticate(db, username, password) {
  if (typeof username !== 'string' || typeof password !== 'string') return null;
  const admin = db
    .prepare('SELECT id, username, password_hash FROM admins WHERE username = ?')
    .get(username.trim());
  const ok = verifyPassword(password, admin ? admin.password_hash : DUMMY_HASH);
  return admin && ok ? { id: admin.id, username: admin.username } : null;
}

export function createSession(db, adminId, hours) {
  const token = crypto.randomBytes(32).toString('base64url');
  const csrfToken = crypto.randomBytes(32).toString('base64url');
  const now = new Date();
  const expires = new Date(now.getTime() + hours * 3600_000);
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(now.toISOString());
  db.prepare(
    'INSERT INTO sessions (token_hash, admin_id, csrf_token, created_at, expires_at) VALUES (?, ?, ?, ?, ?)',
  ).run(sha256(token), adminId, csrfToken, now.toISOString(), expires.toISOString());
  return { token, csrfToken, expires };
}

export function getSession(db, token) {
  if (!token) return null;
  const row = db
    .prepare(
      `SELECT s.csrf_token, s.expires_at, a.id AS admin_id, a.username
         FROM sessions s JOIN admins a ON a.id = s.admin_id
        WHERE s.token_hash = ?`,
    )
    .get(sha256(token));
  if (!row || row.expires_at < new Date().toISOString()) return null;
  return { adminId: row.admin_id, username: row.username, csrfToken: row.csrf_token };
}

export function destroySession(db, token) {
  if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token));
}

export function csrfMatches(expected, received) {
  if (typeof received !== 'string' || received.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(received), Buffer.from(expected));
}

/** Limite simples de tentativas de login por IP (em memória). */
export class LoginRateLimiter {
  constructor({ maxAttempts = 5, windowMs = 15 * 60_000 } = {}) {
    this.maxAttempts = maxAttempts;
    this.windowMs = windowMs;
    this.failures = new Map();
  }
  isBlocked(key) {
    const entry = this.failures.get(key);
    if (!entry) return false;
    if (Date.now() - entry.first > this.windowMs) {
      this.failures.delete(key);
      return false;
    }
    return entry.count >= this.maxAttempts;
  }
  recordFailure(key) {
    const entry = this.failures.get(key);
    if (!entry || Date.now() - entry.first > this.windowMs) {
      this.failures.set(key, { count: 1, first: Date.now() });
    } else {
      entry.count += 1;
    }
  }
  reset(key) {
    this.failures.delete(key);
  }
}
