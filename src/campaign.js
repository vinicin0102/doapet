import { transaction } from './db.js';
import { MODES, computeProgress, raisedForMode } from './progress.js';
import { MoneyError, formatBRL, parseBRL } from './money.js';

export class HttpError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

export const MODE_LABELS = {
  automatico: 'Automático (Pix confirmados)',
  manual: 'Manual',
  hibrido: 'Híbrido (Pix + contribuições externas)',
};

// Origens aceitas para contribuições externas. Doações Pix feitas pelo QR Code do
// site NÃO entram aqui: elas são contadas automaticamente a partir do provedor.
export const EXTERNAL_SOURCES = {
  transferencia: 'Transferência bancária (TED/DOC)',
  deposito: 'Depósito bancário',
  pix_direto: 'Pix direto na conta (fora do QR Code do site)',
  dinheiro: 'Dinheiro em espécie',
  cartao: 'Cartão / maquininha',
  evento: 'Evento / bazar',
  outro: 'Outro',
};

const nowIso = () => new Date().toISOString();

function cleanText(value, { field, required = false, min = 0, max = 500 }) {
  if (value === undefined || value === null) value = '';
  if (typeof value !== 'string') throw new HttpError(400, `${field}: texto inválido.`);
  // Remove caracteres de controle e espaços extras.
  const s = value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  if (required && s.length === 0) throw new HttpError(400, `${field}: campo obrigatório.`);
  if (s.length > 0 && s.length < min) throw new HttpError(400, `${field}: mínimo de ${min} caracteres.`);
  if (s.length > max) throw new HttpError(400, `${field}: máximo de ${max} caracteres.`);
  return s || null;
}

function money(value, field, opts) {
  try {
    return parseBRL(value, opts);
  } catch (err) {
    if (err instanceof MoneyError) throw new HttpError(400, `${field}: ${err.message}`);
    throw err;
  }
}

export function ensureCampaign(db, initialGoal) {
  const exists = db.prepare('SELECT 1 FROM campaign WHERE id = 1').get();
  if (exists) return;
  // Começa no modo automático e com R$ 0,00 informado: nenhum valor fictício.
  db.prepare(
    `INSERT INTO campaign (id, goal_cents, mode, manual_raised_cents, version, updated_at)
     VALUES (1, ?, 'automatico', 0, 1, ?)`,
  ).run(parseBRL(initialGoal, { allowZero: false }), nowIso());
}

function getSettings(db) {
  return db.prepare('SELECT * FROM campaign WHERE id = 1').get();
}

export function getTotals(db) {
  const pix = db
    .prepare(
      `SELECT COUNT(*) AS n, COALESCE(SUM(amount_cents - refunded_cents), 0) AS total
         FROM pix_donations WHERE status = 'confirmada'`,
    )
    .get();
  const ext = db
    .prepare(
      `SELECT COUNT(*) AS n, COALESCE(SUM(amount_cents), 0) AS total
         FROM external_contributions WHERE removed_at IS NULL`,
    )
    .get();
  return {
    pixCents: Number(pix.total),
    pixCount: Number(pix.n),
    externalCents: Number(ext.total),
    externalCount: Number(ext.n),
  };
}

function snapshot(settings, totals) {
  const raised = raisedForMode(settings.mode, {
    ...totals,
    manualCents: settings.manual_raised_cents,
  });
  return {
    meta: formatBRL(settings.goal_cents),
    modo: settings.mode,
    valorManual: formatBRL(settings.manual_raised_cents),
    origemManual: settings.manual_source,
    arrecadadoExibido: formatBRL(raised),
  };
}

function toPublicProgress(p) {
  return {
    meta: p.goalCents / 100,
    arrecadado: p.raisedCents / 100,
    falta: p.remainingCents / 100,
    percentual: p.percent,
    percentualBarra: p.barPercent,
    metaAtingida: p.goalReached,
  };
}

/** Dados exibidos publicamente na página inicial. */
export function getPublicSummary(db) {
  const settings = getSettings(db);
  const totals = getTotals(db);
  const raised = raisedForMode(settings.mode, { ...totals, manualCents: settings.manual_raised_cents });
  return {
    ...toPublicProgress(computeProgress(settings.goal_cents, raised)),
    modo: settings.mode,
    atualizadoEm: settings.updated_at,
  };
}

export function listHistory(db, limit = 100) {
  return db
    .prepare(
      `SELECT id, changed_at, admin_username, action, previous_json, new_json, note
         FROM campaign_history ORDER BY id DESC LIMIT ?`,
    )
    .all(limit)
    .map((r) => ({
      id: r.id,
      data: r.changed_at,
      administrador: r.admin_username,
      acao: r.action,
      valoresAnteriores: r.previous_json ? JSON.parse(r.previous_json) : null,
      valoresNovos: r.new_json ? JSON.parse(r.new_json) : null,
      observacao: r.note,
    }));
}

/** Estado completo para o painel administrativo. */
export function getAdminState(db) {
  const settings = getSettings(db);
  const totals = getTotals(db);
  const previewFor = (mode) =>
    toPublicProgress(
      computeProgress(
        settings.goal_cents,
        raisedForMode(mode, { ...totals, manualCents: settings.manual_raised_cents }),
      ),
    );
  return {
    versao: settings.version,
    meta: settings.goal_cents / 100,
    modo: settings.mode,
    valorManual: settings.manual_raised_cents / 100,
    origemManual: settings.manual_source,
    atualizadoEm: settings.updated_at,
    atualizadoPor: settings.updated_by,
    totais: {
      pixConfirmado: totals.pixCents / 100,
      quantidadePix: totals.pixCount,
      contribuicoesExternas: totals.externalCents / 100,
      quantidadeContribuicoes: totals.externalCount,
    },
    progresso: previewFor(settings.mode),
    contribuicoes: db
      .prepare(
        `SELECT id, amount_cents, source, reference, received_on, notes, created_at, created_by
           FROM external_contributions WHERE removed_at IS NULL ORDER BY received_on DESC, id DESC`,
      )
      .all()
      .map((c) => ({
        id: c.id,
        valor: c.amount_cents / 100,
        origem: c.source,
        origemDescricao: EXTERNAL_SOURCES[c.source] ?? c.source,
        referencia: c.reference,
        dataRecebimento: c.received_on,
        observacao: c.notes,
        registradoEm: c.created_at,
        registradoPor: c.created_by,
      })),
    pixRecentes: db
      .prepare(
        `SELECT txid, amount_cents, refunded_cents, status, paid_at, received_at
           FROM pix_donations ORDER BY received_at DESC LIMIT 20`,
      )
      .all()
      .map((p) => ({
        txid: p.txid,
        valor: p.amount_cents / 100,
        devolvido: p.refunded_cents / 100,
        status: p.status,
        pagoEm: p.paid_at,
        recebidoEm: p.received_at,
      })),
    historico: listHistory(db),
    modos: MODE_LABELS,
    origensExternas: EXTERNAL_SOURCES,
  };
}

function addHistory(db, { admin, action, previous, next, note }) {
  db.prepare(
    `INSERT INTO campaign_history (changed_at, admin_username, action, previous_json, new_json, note)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    nowIso(),
    admin,
    action,
    previous ? JSON.stringify(previous) : null,
    next ? JSON.stringify(next) : null,
    note ?? null,
  );
}

// A versão protege o formulário de configuração contra edições simultâneas.
function bumpVersion(db, admin) {
  db.prepare('UPDATE campaign SET version = version + 1, updated_at = ?, updated_by = ? WHERE id = 1').run(
    nowIso(),
    admin,
  );
}

function touch(db, admin) {
  db.prepare('UPDATE campaign SET updated_at = ?, updated_by = ? WHERE id = 1').run(nowIso(), admin);
}

function checkVersion(settings, version) {
  if (!Number.isInteger(version)) throw new HttpError(400, 'Versão dos dados ausente. Recarregue o painel.');
  if (version !== settings.version) {
    throw new HttpError(
      409,
      'Os dados da campanha foram alterados por outro administrador. Recarregue o painel antes de salvar.',
      { codigo: 'VERSAO_DESATUALIZADA' },
    );
  }
}

/**
 * Atualiza meta, modo e valor manual. Regras:
 *  - modo automático/híbrido: o valor manual NÃO pode ser alterado (evita sobrescrever
 *    silenciosamente o total de Pix confirmados);
 *  - modo manual: exige valor e origem; trocar para manual exige confirmação explícita.
 */
export function updateCampaign(db, admin, input) {
  if (!input || typeof input !== 'object') throw new HttpError(400, 'Dados inválidos.');

  return transaction(db, () => {
    const settings = getSettings(db);
    checkVersion(settings, input.versao);

    const goal = money(input.meta, 'Meta', { allowZero: false });
    const mode = input.modo;
    if (!MODES.includes(mode)) throw new HttpError(400, 'Modo de gerenciamento inválido.');
    const note = cleanText(input.observacao, { field: 'Observação', max: 500 });

    let manualCents = settings.manual_raised_cents;
    let manualSource = settings.manual_source;
    const manualProvided = input.valorManual !== undefined && input.valorManual !== null && input.valorManual !== '';

    if (mode === 'manual') {
      if (!manualProvided) throw new HttpError(400, 'Informe o valor arrecadado no modo manual.');
      manualCents = money(input.valorManual, 'Valor arrecadado informado manualmente');
      manualSource = cleanText(input.origemManual, {
        field: 'Origem do valor informado',
        required: true,
        min: 3,
        max: 500,
      });
      if (settings.mode !== 'manual' && input.confirmarModoManual !== true) {
        const { pixCents } = getTotals(db);
        throw new HttpError(
          409,
          `No modo manual a barra pública passa a exibir somente o valor informado, ` +
            `substituindo o total de Pix confirmados (${formatBRL(pixCents)}). Confirme para continuar.`,
          { codigo: 'CONFIRMACAO_NECESSARIA', pixConfirmado: pixCents / 100 },
        );
      }
    } else if (manualProvided) {
      const attempted = money(input.valorManual, 'Valor arrecadado informado manualmente');
      if (attempted !== settings.manual_raised_cents) {
        throw new HttpError(
          422,
          mode === 'automatico'
            ? 'No modo automático o valor arrecadado é calculado pelas doações Pix confirmadas e não ' +
                'pode ser editado manualmente. Mude para o modo manual ou híbrido.'
            : 'No modo híbrido o valor arrecadado é a soma dos Pix confirmados com as contribuições ' +
                'externas registradas. Registre a contribuição na lista em vez de editar o total.',
          { codigo: 'EDICAO_MANUAL_BLOQUEADA' },
        );
      }
    }

    const changed =
      goal !== settings.goal_cents ||
      mode !== settings.mode ||
      manualCents !== settings.manual_raised_cents ||
      manualSource !== settings.manual_source;
    if (!changed) return { alterado: false };

    const totals = getTotals(db);
    const previous = snapshot(settings, totals);
    db.prepare(
      `UPDATE campaign SET goal_cents = ?, mode = ?, manual_raised_cents = ?, manual_source = ? WHERE id = 1`,
    ).run(goal, mode, manualCents, manualSource);
    bumpVersion(db, admin);
    const next = snapshot(getSettings(db), totals);
    addHistory(db, { admin, action: 'configuracao_atualizada', previous, next, note });
    return { alterado: true };
  });
}

export function addExternalContribution(db, admin, input) {
  if (!input || typeof input !== 'object') throw new HttpError(400, 'Dados inválidos.');
  const amount = money(input.valor, 'Valor', { allowZero: false });
  const source = input.origem;
  if (!Object.hasOwn(EXTERNAL_SOURCES, source)) throw new HttpError(400, 'Origem da contribuição inválida.');
  const reference = cleanText(input.referencia, { field: 'Referência/comprovante', max: 120 });
  const notes = cleanText(input.observacao, { field: 'Observação', max: 500 });
  if ((source === 'pix_direto' || source === 'outro') && !reference && !notes) {
    throw new HttpError(400, 'Informe o comprovante ou uma observação que identifique a contribuição.');
  }
  if (source === 'pix_direto' && !reference) {
    throw new HttpError(400, 'Para Pix direto, informe o ID da transação (E2E) como referência.');
  }
  const receivedOn = String(input.dataRecebimento ?? '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(receivedOn) || Number.isNaN(Date.parse(receivedOn))) {
    throw new HttpError(400, 'Data de recebimento inválida.');
  }
  if (receivedOn > new Date().toISOString().slice(0, 10)) {
    throw new HttpError(400, 'A data de recebimento não pode estar no futuro.');
  }

  return transaction(db, () => {
    if (reference) {
      // Sem duplicidade: a mesma referência não pode ser registrada duas vezes,
      // nem corresponder a um Pix que já é contado automaticamente.
      const dupPix = db
        .prepare('SELECT 1 FROM pix_donations WHERE txid = ? OR e2e_id = ?')
        .get(reference, reference);
      if (dupPix) {
        throw new HttpError(409, 'Esta referência corresponde a um Pix já contabilizado automaticamente.');
      }
      const dupExt = db
        .prepare(
          'SELECT 1 FROM external_contributions WHERE reference = ? COLLATE NOCASE AND removed_at IS NULL',
        )
        .get(reference);
      if (dupExt) throw new HttpError(409, 'Já existe uma contribuição registrada com esta referência.');
    }
    const settings = getSettings(db);
    const totalsBefore = getTotals(db);
    const { lastInsertRowid } = db
      .prepare(
        `INSERT INTO external_contributions
           (amount_cents, source, reference, received_on, notes, created_at, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(amount, source, reference, receivedOn, notes, nowIso(), admin);
    touch(db, admin);
    addHistory(db, {
      admin,
      action: 'contribuicao_registrada',
      previous: {
        contribuicoesExternas: formatBRL(totalsBefore.externalCents),
        arrecadadoExibido: snapshot(settings, totalsBefore).arrecadadoExibido,
      },
      next: {
        contribuicao: Number(lastInsertRowid),
        valor: formatBRL(amount),
        origem: EXTERNAL_SOURCES[source],
        referencia: reference,
        dataRecebimento: receivedOn,
        contribuicoesExternas: formatBRL(totalsBefore.externalCents + amount),
        arrecadadoExibido: snapshot(settings, getTotals(db)).arrecadadoExibido,
      },
      note: notes,
    });
    return { id: Number(lastInsertRowid) };
  });
}

export function removeExternalContribution(db, admin, id, input = {}) {
  const reason = cleanText(input.motivo, { field: 'Motivo da remoção', required: true, min: 3, max: 500 });
  return transaction(db, () => {
    const row = db
      .prepare('SELECT * FROM external_contributions WHERE id = ? AND removed_at IS NULL')
      .get(id);
    if (!row) throw new HttpError(404, 'Contribuição não encontrada.');
    const settings = getSettings(db);
    const totalsBefore = getTotals(db);
    // Remoção lógica: o registro permanece para auditoria.
    db.prepare(
      'UPDATE external_contributions SET removed_at = ?, removed_by = ?, removal_reason = ? WHERE id = ?',
    ).run(nowIso(), admin, reason, id);
    touch(db, admin);
    addHistory(db, {
      admin,
      action: 'contribuicao_removida',
      previous: {
        contribuicao: row.id,
        valor: formatBRL(row.amount_cents),
        origem: EXTERNAL_SOURCES[row.source] ?? row.source,
        referencia: row.reference,
        contribuicoesExternas: formatBRL(totalsBefore.externalCents),
        arrecadadoExibido: snapshot(settings, totalsBefore).arrecadadoExibido,
      },
      next: {
        contribuicoesExternas: formatBRL(totalsBefore.externalCents - row.amount_cents),
        arrecadadoExibido: snapshot(settings, getTotals(db)).arrecadadoExibido,
      },
      note: reason,
    });
  });
}

const STATUS_RANK = { pendente: 0, confirmada: 1, devolvida: 2 };

/**
 * Registra/atualiza uma doação Pix vinda do provedor (webhook assinado).
 * Idempotente: o mesmo txid nunca é somado duas vezes, e o status só avança
 * (pendente → confirmada → devolvida), mesmo que eventos cheguem fora de ordem.
 * Retorna true se o total arrecadado pode ter mudado.
 */
export function recordPixEvent(db, event) {
  return transaction(db, () => {
    const now = nowIso();
    const existing = db.prepare('SELECT * FROM pix_donations WHERE txid = ?').get(event.txid);
    if (existing && existing.amount_cents !== event.amountCents) {
      throw new HttpError(409, 'Valor divergente para um txid já registrado.');
    }
    const previousStatus = existing?.status ?? 'pendente';
    let status = STATUS_RANK[event.status] > STATUS_RANK[previousStatus] ? event.status : previousStatus;
    const refunded = Math.min(
      Math.max(existing?.refunded_cents ?? 0, event.refundedCents ?? 0),
      event.amountCents,
    );
    if (refunded === event.amountCents && status === 'confirmada') status = 'devolvida';

    if (!existing) {
      db.prepare(
        `INSERT INTO pix_donations
           (txid, e2e_id, amount_cents, refunded_cents, status, paid_at, received_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(event.txid, event.e2eId ?? null, event.amountCents, refunded, status, event.paidAt ?? null, now, now);
      return status !== 'pendente';
    }
    const unchanged =
      status === existing.status &&
      refunded === existing.refunded_cents &&
      (existing.e2e_id || !event.e2eId) &&
      (existing.paid_at || !event.paidAt);
    if (unchanged) return false;
    db.prepare(
      `UPDATE pix_donations
          SET status = ?, refunded_cents = ?, e2e_id = COALESCE(e2e_id, ?),
              paid_at = COALESCE(paid_at, ?), updated_at = ?
        WHERE txid = ?`,
    ).run(status, refunded, event.e2eId ?? null, event.paidAt ?? null, now, event.txid);
    return status !== existing.status || refunded !== existing.refunded_cents;
  });
}
