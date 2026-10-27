// Integração com a API v3 da ZuckPay (gateway de pagamentos Pix).
// Contrato: https://github.com/ZuckPay/zuckpay-mcp (resource zuckpay://docs/api).
//
//  - Autenticação HTTP Basic (client_id:client_secret), nunca no corpo.
//  - A base URL precisa do "www": sem ele o CDN responde 301 e converte POST em GET.
//  - Criação de cobrança NUNCA é repetida automaticamente (movimenta dinheiro);
//    a idempotência vem do external_id_client.
//  - O estado autoritativo de um pagamento é o GET /v3/pix/status — o webhook
//    serve apenas de gatilho para consultá-lo.

import crypto from 'node:crypto';

export const DEFAULT_BASE_URL = 'https://www.zuckpay.com.br/conta';
const TIMEOUT_MS = 15_000;

export class ZuckPayError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const pick = (obj, ...keys) => {
  for (const key of keys) {
    const value = obj?.[key];
    if (typeof value === 'string' && value !== '') return value;
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  }
  return undefined;
};

export function createZuckPayClient({ clientId, clientSecret, baseUrl = DEFAULT_BASE_URL, fetchImpl = fetch }) {
  const auth = 'Basic ' + Buffer.from(`${clientId}:${clientSecret}`, 'utf8').toString('base64');

  async function request(method, path, { query, body } = {}) {
    const url = new URL(baseUrl + path);
    for (const [key, value] of Object.entries(query ?? {})) url.searchParams.set(key, value);
    let res;
    try {
      res = await fetchImpl(url, {
        method,
        headers: {
          Authorization: auth,
          Accept: 'application/json',
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        redirect: 'error',
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      console.error(`ZuckPay ${method} ${path}: falha de rede (${err.name})`);
      throw new ZuckPayError(502, 'Não foi possível falar com o processador de pagamentos. Tente novamente.');
    }
    const text = await res.text();
    let data;
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      throw new ZuckPayError(502, 'Resposta inesperada do processador de pagamentos.');
    }
    if (!res.ok) {
      const message = pick(data, 'message', 'error') ?? `Erro ${res.status} no processador de pagamentos.`;
      console.error(`ZuckPay ${method} ${path}: HTTP ${res.status} — ${message}`);
      // 400 = dados recusados (ex.: valor mínimo da adquirente): a mensagem é útil ao doador.
      throw new ZuckPayError(res.status === 400 ? 400 : 502, res.status === 400 ? message : 'O processador de pagamentos recusou a solicitação. Tente novamente.');
    }
    return data;
  }

  return {
    /** Cria a cobrança Pix. Retorna o código copia-e-cola e o ID da transação. */
    async createPixCharge({ nome, cpf, email, telefone, valor, descricao, urlnoty, externalId }) {
      const data = await request('POST', '/v3/pix/qrcode', {
        body: {
          nome,
          cpf,
          email,
          telefone,
          valor,
          descricao,
          external_id_client: externalId,
          ...(urlnoty ? { urlnoty } : {}),
        },
      });
      const copiaECola = pick(data, 'qrcode');
      if (!copiaECola) throw new ZuckPayError(502, 'O processador de pagamentos não retornou o código Pix.');
      return {
        transactionId: pick(data, 'transactionId', 'id') ?? null,
        copiaECola,
        reused: data.idempotency === true || data.idempotency === 'true' || data.idempotency === 1,
      };
    },

    /** Consulta o status autoritativo (PENDING, PAID, FAILED, EXPIRADO, REFUNDED...). */
    async getStatus({ externalId, transactionId }) {
      const query = externalId ? { external_id_client: externalId } : { transactionId };
      const data = await request('GET', '/v3/pix/status', { query });
      const amount = Number(pick(data, 'amount', 'valor'));
      return {
        status: (pick(data, 'status') ?? '').toUpperCase(),
        transactionId: pick(data, 'transactionId', 'id') ?? null,
        amountCents: Number.isFinite(amount) ? Math.round(amount * 100) : null,
        paidAt: pick(data, 'paid_at', 'data_pagamento') ?? null,
      };
    },
  };
}

/** Converte o status da ZuckPay para o status interno das doações. */
export function mapZuckPayStatus(status) {
  switch (String(status).toUpperCase()) {
    case 'PAID':
      return 'confirmada';
    case 'REFUNDED':
    case 'CHARGEBACK':
      return 'devolvida';
    default:
      return 'pendente'; // PENDING, WAITING_PAYMENT, EXPIRED, EXPIRADO, FAILED, REFUSED...
  }
}

/**
 * Valida a assinatura do postback:
 *   X-ZuckPay-Signature: t=<unix_ts>,v1=<hex>  com  v1 = HMAC-SHA256("<t>.<corpo cru>", secret)
 * Rejeita timestamps fora da janela de tolerância (proteção contra reenvio).
 */
export function verifyZuckPaySignature(rawBody, header, secret, { nowSeconds = Date.now() / 1000, toleranceSeconds = 300 } = {}) {
  if (!secret || typeof header !== 'string') return false;
  const parts = {};
  for (const piece of header.split(',')) {
    const i = piece.indexOf('=');
    if (i > 0) parts[piece.slice(0, i).trim()] = piece.slice(i + 1).trim();
  }
  const ts = Number(parts.t);
  if (!Number.isFinite(ts) || Math.abs(nowSeconds - ts) > toleranceSeconds) return false;
  const provided = String(parts.v1 ?? '');
  if (!/^[0-9a-f]{64}$/i.test(provided)) return false;
  const expected = crypto.createHmac('sha256', secret).update(`${parts.t}.`).update(rawBody).digest('hex');
  return crypto.timingSafeEqual(Buffer.from(provided.toLowerCase(), 'hex'), Buffer.from(expected, 'hex'));
}

/**
 * Extrai os identificadores do corpo do postback. O formato exato não é
 * documentado, então procuramos os nomes de campo usados pela API, inclusive
 * dentro de "data"/"transaction".
 */
export function extractWebhookIds(body) {
  const candidates = [body, body?.data, body?.transaction, body?.payload].filter(
    (o) => o && typeof o === 'object',
  );
  let externalId;
  let transactionId;
  for (const obj of candidates) {
    externalId ??= pick(obj, 'external_id_client', 'externalIdClient', 'external_id');
    transactionId ??= pick(obj, 'transactionId', 'transaction_id', 'id');
  }
  const valid = (v) => (v && /^[A-Za-z0-9._:-]{1,100}$/.test(v) ? v : undefined);
  return { externalId: valid(externalId), transactionId: valid(transactionId) };
}
