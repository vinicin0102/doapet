// Acesso ao banco PostgreSQL.
//  - Produção (Vercel): DATABASE_URL/POSTGRES_URL apontando para o Postgres (ex.: Neon).
//  - Desenvolvimento e testes: sem DATABASE_URL, usa o PGlite (Postgres embutido) em disco ou memória.
// Todos os valores em dinheiro são guardados em CENTAVOS (BIGINT).

const SCHEMA = `
CREATE TABLE IF NOT EXISTS admins (
  id            BIGSERIAL PRIMARY KEY,
  username      TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  created_at    TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS admins_username ON admins (lower(username));

CREATE TABLE IF NOT EXISTS sessions (
  token_hash  TEXT PRIMARY KEY,
  admin_id    BIGINT NOT NULL REFERENCES admins(id) ON DELETE CASCADE,
  csrf_token  TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  expires_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS login_failures (
  ip          TEXT PRIMARY KEY,
  count       INTEGER NOT NULL,
  first_at    TEXT NOT NULL
);

-- Configuração da campanha (linha única).
CREATE TABLE IF NOT EXISTS campaign (
  id                  INTEGER PRIMARY KEY CHECK (id = 1),
  goal_cents          BIGINT NOT NULL CHECK (goal_cents > 0),
  mode                TEXT NOT NULL CHECK (mode IN ('automatico', 'manual', 'hibrido')),
  manual_raised_cents BIGINT NOT NULL DEFAULT 0 CHECK (manual_raised_cents >= 0),
  manual_source       TEXT,
  version             INTEGER NOT NULL DEFAULT 1,
  updated_at          TEXT NOT NULL,
  updated_by          TEXT
);

-- Doações Pix recebidas do provedor. txid único impede contagem em dobro.
CREATE TABLE IF NOT EXISTS pix_donations (
  txid           TEXT PRIMARY KEY,
  e2e_id         TEXT UNIQUE,
  amount_cents   BIGINT NOT NULL CHECK (amount_cents > 0),
  refunded_cents BIGINT NOT NULL DEFAULT 0 CHECK (refunded_cents >= 0 AND refunded_cents <= amount_cents),
  status         TEXT NOT NULL CHECK (status IN ('pendente', 'confirmada', 'devolvida')),
  paid_at        TEXT,
  received_at    TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);

-- Contribuições recebidas por outros meios (usadas no modo híbrido).
CREATE TABLE IF NOT EXISTS external_contributions (
  id             BIGSERIAL PRIMARY KEY,
  amount_cents   BIGINT NOT NULL CHECK (amount_cents > 0),
  source         TEXT NOT NULL,
  reference      TEXT,
  received_on    TEXT NOT NULL,
  notes          TEXT,
  created_at     TEXT NOT NULL,
  created_by     TEXT NOT NULL,
  removed_at     TEXT,
  removed_by     TEXT,
  removal_reason TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS external_contributions_reference
  ON external_contributions (lower(reference))
  WHERE reference IS NOT NULL AND removed_at IS NULL;

-- Histórico de alterações administrativas (somente inserção).
CREATE TABLE IF NOT EXISTS campaign_history (
  id             BIGSERIAL PRIMARY KEY,
  changed_at     TEXT NOT NULL,
  admin_username TEXT NOT NULL,
  action         TEXT NOT NULL,
  previous_json  TEXT,
  new_json       TEXT,
  note           TEXT
);
`;

/**
 * Interface comum aos dois drivers:
 *   db.query(sql, params) → linhas
 *   db.one(sql, params)   → primeira linha ou undefined
 *   db.tx(async (t) => …) → executa em transação (t tem query/one)
 */
function wrap(run) {
  return {
    query: async (sql, params = []) => (await run(sql, params)).rows,
    one: async (sql, params = []) => (await run(sql, params)).rows[0],
  };
}

async function openPg(connectionString) {
  const { default: pg } = await import('pg');
  // BIGINT/NUMERIC chegam como texto; nossos valores cabem com folga em Number.
  pg.types.setTypeParser(20, Number);
  pg.types.setTypeParser(1700, Number);
  const pool = new pg.Pool({ connectionString, max: 5, idleTimeoutMillis: 10_000 });
  return {
    ...wrap((sql, params) => pool.query(sql, params)),
    async tx(fn) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await fn(wrap((sql, params) => client.query(sql, params)));
        await client.query('COMMIT');
        return result;
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    },
    exec: (sql) => pool.query(sql),
    close: () => pool.end(),
  };
}

async function openPglite(dataDir) {
  const { PGlite, types } = await import('@electric-sql/pglite');
  const options = { parsers: { [types.INT8]: Number, [types.NUMERIC]: Number } };
  if (dataDir !== ':memory:') {
    const fs = await import('node:fs');
    fs.mkdirSync(dataDir, { recursive: true });
  }
  const db = dataDir === ':memory:' ? new PGlite(options) : new PGlite(dataDir, options);
  // O PGlite tem uma única conexão: todas as operações passam por uma fila,
  // para que uma consulta avulsa nunca caia dentro de uma transação em andamento.
  let queue = Promise.resolve();
  const serial = (fn) => {
    const run = queue.then(fn);
    queue = run.catch(() => {});
    return run;
  };
  return {
    ...wrap((sql, params) => serial(() => db.query(sql, params))),
    tx: (fn) => serial(() => db.transaction((t) => fn(wrap((sql, params) => t.query(sql, params))))),
    exec: (sql) => serial(() => db.exec(sql)),
    close: () => serial(() => db.close()),
  };
}

export async function openDatabase(config) {
  const db = config.databaseUrl ? await openPg(config.databaseUrl) : await openPglite(config.localDataDir);
  // Trava consultiva evita corrida quando várias instâncias criam o esquema ao mesmo tempo.
  await db.tx(async (t) => {
    await t.query('SELECT pg_advisory_xact_lock(424242)');
    for (const statement of SCHEMA.split(';').map((s) => s.trim()).filter(Boolean)) {
      await t.query(statement);
    }
  });
  return db;
}
