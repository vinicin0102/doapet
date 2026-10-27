import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS admins (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  created_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash  TEXT PRIMARY KEY,
  admin_id    INTEGER NOT NULL REFERENCES admins(id) ON DELETE CASCADE,
  csrf_token  TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  expires_at  TEXT NOT NULL
);

-- Configuração da campanha (linha única).
CREATE TABLE IF NOT EXISTS campaign (
  id                  INTEGER PRIMARY KEY CHECK (id = 1),
  goal_cents          INTEGER NOT NULL CHECK (goal_cents > 0),
  mode                TEXT NOT NULL CHECK (mode IN ('automatico', 'manual', 'hibrido')),
  manual_raised_cents INTEGER NOT NULL DEFAULT 0 CHECK (manual_raised_cents >= 0),
  manual_source       TEXT,
  version             INTEGER NOT NULL DEFAULT 1,
  updated_at          TEXT NOT NULL,
  updated_by          TEXT
);

-- Doações Pix recebidas do provedor. txid único impede contagem em dobro.
CREATE TABLE IF NOT EXISTS pix_donations (
  txid          TEXT PRIMARY KEY,
  e2e_id        TEXT UNIQUE,
  amount_cents  INTEGER NOT NULL CHECK (amount_cents > 0),
  refunded_cents INTEGER NOT NULL DEFAULT 0 CHECK (refunded_cents >= 0 AND refunded_cents <= amount_cents),
  status        TEXT NOT NULL CHECK (status IN ('pendente', 'confirmada', 'devolvida')),
  paid_at       TEXT,
  received_at   TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

-- Contribuições recebidas por outros meios (usadas no modo híbrido).
CREATE TABLE IF NOT EXISTS external_contributions (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  amount_cents   INTEGER NOT NULL CHECK (amount_cents > 0),
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
  ON external_contributions (reference COLLATE NOCASE)
  WHERE reference IS NOT NULL AND removed_at IS NULL;

-- Histórico de alterações administrativas (somente inserção).
CREATE TABLE IF NOT EXISTS campaign_history (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  changed_at     TEXT NOT NULL,
  admin_username TEXT NOT NULL,
  action         TEXT NOT NULL,
  previous_json  TEXT,
  new_json       TEXT,
  note           TEXT
);
`;

export function openDatabase(dbPath) {
  if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  db.exec(SCHEMA);
  return db;
}

/** Executa fn dentro de uma transação, com rollback em caso de erro. */
export function transaction(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
