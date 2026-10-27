// Doações pelo quadro da página inicial via ZuckPay: cria a cobrança, acompanha
// o status e confirma o pagamento. Só cobranças criadas por este site (txid
// "DOAPET…") entram na campanha — outras vendas da conta ZuckPay são ignoradas.

import { HttpError, recordPixEvent } from './campaign.js';
import { newTxid } from './brcode.js';
import { mapZuckPayStatus } from './zuckpay.js';

const PROVIDER = 'zuckpay';
// Intervalo mínimo entre consultas de status da mesma doação à ZuckPay.
const STATUS_CHECK_INTERVAL_MS = 8_000;

const nowIso = () => new Date().toISOString();

/** Cria a cobrança na ZuckPay e registra a doação como pendente (não conta na meta). */
export async function createDonationCharge(db, zuckpay, { valor, doador, urlnoty }) {
  const txid = newTxid();
  const amountCents = Math.round(valor * 100);
  const charge = await zuckpay.createPixCharge({
    ...doador,
    valor,
    descricao: 'Doação — campanha da ração',
    urlnoty,
    externalId: txid,
  });
  const now = nowIso();
  await db.query(
    `INSERT INTO pix_donations
       (txid, amount_cents, status, received_at, updated_at, provider, provider_tx_id, last_checked_at)
     VALUES ($1, $2, 'pendente', $3, $3, $4, $5, $3)`,
    [txid, amountCents, now, PROVIDER, charge.transactionId],
  );
  return { id: txid, copiaECola: charge.copiaECola };
}

/**
 * Consulta a ZuckPay e atualiza a doação. O valor confirmado precisa bater com o
 * valor cobrado; caso contrário a doação não é contada e o caso vai para o log.
 * Retorna o status interno atualizado.
 */
export async function syncDonation(db, zuckpay, txid, { force = false } = {}) {
  const row = await db.one('SELECT * FROM pix_donations WHERE txid = $1 AND provider = $2', [txid, PROVIDER]);
  if (!row) return null;
  if (row.status !== 'pendente' && !force) return row.status;
  const lastCheck = Date.parse(row.last_checked_at ?? 0);
  if (!force && Date.now() - lastCheck < STATUS_CHECK_INTERVAL_MS) return row.status;

  await db.query('UPDATE pix_donations SET last_checked_at = $1 WHERE txid = $2', [nowIso(), txid]);
  const remote = await zuckpay.getStatus({ externalId: txid });
  const status = mapZuckPayStatus(remote.status);
  if (status === 'pendente') return row.status;
  if (status === 'confirmada' && remote.amountCents !== null && remote.amountCents !== row.amount_cents) {
    console.error(`ZuckPay: valor divergente na doação ${txid} (${remote.amountCents} ≠ ${row.amount_cents}).`);
    return row.status;
  }
  await recordPixEvent(db, {
    txid,
    amountCents: row.amount_cents,
    refundedCents: status === 'devolvida' ? row.amount_cents : 0,
    status: status === 'devolvida' ? 'confirmada' : status,
    paidAt: remote.paidAt,
  });
  if (row.provider_tx_id === null && remote.transactionId) {
    await db.query('UPDATE pix_donations SET provider_tx_id = $1 WHERE txid = $2', [remote.transactionId, txid]);
  }
  return (await db.one('SELECT status FROM pix_donations WHERE txid = $1', [txid])).status;
}

/** Encontra a doação a partir dos IDs do postback (nosso external_id ou o ID da ZuckPay). */
export async function findDonationTxid(db, { externalId, transactionId }) {
  if (externalId) {
    const row = await db.one('SELECT txid FROM pix_donations WHERE txid = $1 AND provider = $2', [
      externalId,
      PROVIDER,
    ]);
    if (row) return row.txid;
  }
  if (transactionId) {
    const row = await db.one('SELECT txid FROM pix_donations WHERE provider_tx_id = $1 AND provider = $2', [
      transactionId,
      PROVIDER,
    ]);
    if (row) return row.txid;
  }
  return null;
}

/** Status público de uma doação (para a página mostrar "pagamento confirmado"). */
export async function getDonationStatus(db, zuckpay, txid) {
  if (!/^DOAPET[A-Z0-9]{19}$/.test(String(txid))) throw new HttpError(400, 'Doação inválida.');
  let status;
  try {
    status = await syncDonation(db, zuckpay, txid);
  } catch (err) {
    // Falha temporária na ZuckPay: devolve o último status conhecido.
    console.error(`ZuckPay: falha ao consultar a doação ${txid}: ${err.message}`);
    status = (await db.one('SELECT status FROM pix_donations WHERE txid = $1', [txid]))?.status;
  }
  if (!status) throw new HttpError(404, 'Doação não encontrada.');
  return { status };
}
