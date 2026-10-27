import crypto from 'node:crypto';
import { MoneyError, parsePixAmount } from '../public/js/shared/money.js';

/**
 * Verifica a assinatura HMAC-SHA256 do corpo bruto do webhook.
 * Cabeçalho esperado: "X-Pix-Signature: sha256=<hex>".
 */
export function verifySignature(rawBody, header, secret) {
  if (!secret || typeof header !== 'string') return false;
  const received = header.replace(/^sha256=/i, '').trim();
  if (!/^[0-9a-f]{64}$/i.test(received)) return false;
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  return crypto.timingSafeEqual(Buffer.from(received.toLowerCase(), 'hex'), Buffer.from(expected, 'hex'));
}

const STATUS_MAP = {
  concluida: 'confirmada',
  confirmada: 'confirmada',
  confirmed: 'confirmada',
  approved: 'confirmada',
  paid: 'confirmada',
  devolvida: 'devolvida',
  refunded: 'devolvida',
};

function cleanId(value, field) {
  const s = String(value ?? '').trim();
  if (!/^[A-Za-z0-9._:-]{1,100}$/.test(s)) throw new MoneyError(`${field} inválido.`);
  return s;
}

function sumRefunds(devolucoes) {
  if (!Array.isArray(devolucoes)) return 0;
  return devolucoes
    .filter((d) => String(d?.status ?? '').toUpperCase() === 'DEVOLVIDO')
    .reduce((acc, d) => acc + parsePixAmount(d.valor), 0);
}

/**
 * Converte o corpo do webhook em eventos normalizados.
 *
 * Formatos aceitos:
 *  1. Padrão do Banco Central (API Pix), usado por Efí, Itaú, Inter, Sicoob etc.:
 *     { "pix": [ { "endToEndId", "txid", "valor": "10.00", "horario", "devolucoes": [...] } ] }
 *     Cada item representa um Pix efetivamente LIQUIDADO, portanto confirmado.
 *  2. Formato genérico (para adaptadores de outros provedores):
 *     { "txid", "e2eid", "valor": "10.00", "status": "CONCLUIDA" | "DEVOLVIDA" | ..., "horario" }
 *     Status não reconhecidos são tratados como "pendente" e NÃO contam na meta.
 */
export function normalizePixPayload(body) {
  if (!body || typeof body !== 'object') throw new MoneyError('Payload inválido.');
  if (Array.isArray(body.pix)) {
    return body.pix.map((p) => {
      const e2eId = cleanId(p.endToEndId, 'endToEndId');
      return {
        txid: p.txid ? cleanId(p.txid, 'txid') : e2eId,
        e2eId,
        amountCents: parsePixAmount(p.valor),
        refundedCents: sumRefunds(p.devolucoes),
        status: 'confirmada',
        paidAt: typeof p.horario === 'string' ? p.horario : null,
      };
    });
  }
  return [
    {
      txid: cleanId(body.txid, 'txid'),
      e2eId: body.e2eid || body.endToEndId ? cleanId(body.e2eid || body.endToEndId, 'endToEndId') : null,
      amountCents: parsePixAmount(body.valor ?? body.amount),
      refundedCents: 0,
      status: STATUS_MAP[String(body.status ?? '').toLowerCase()] ?? 'pendente',
      paidAt: typeof body.horario === 'string' ? body.horario : null,
    },
  ];
}
