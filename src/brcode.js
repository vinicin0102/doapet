// Geração do "Pix Copia e Cola" (BR Code, padrão EMV do Banco Central) com valor definido.
// Referência: Manual de Padrões para Iniciação do Pix (BR Code).

import crypto from 'node:crypto';

export class PixConfigError extends Error {}

/** CRC16-CCITT-FALSE (polinômio 0x1021, valor inicial 0xFFFF), exigido no campo 63. */
export function crc16(payload) {
  let crc = 0xffff;
  for (const byte of Buffer.from(payload, 'utf8')) {
    crc ^= byte << 8;
    for (let i = 0; i < 8; i++) {
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc.toString(16).toUpperCase().padStart(4, '0');
}

const field = (id, value) => `${id}${String(Buffer.byteLength(value, 'utf8')).padStart(2, '0')}${value}`;

/** Remove acentos e caracteres fora do conjunto aceito pelos bancos. */
function sanitize(text, max) {
  return String(text ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z0-9 .\-]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toUpperCase()
    .slice(0, max)
    .trim();
}

/** Valida a chave Pix (e-mail, celular +55, CPF, CNPJ ou chave aleatória). */
export function normalizePixKey(key) {
  const k = String(key ?? '').trim();
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(k) && k.length <= 77) return k.toLowerCase();
  if (/^\+55\d{10,11}$/.test(k)) return k;
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(k)) return k.toLowerCase();
  const digits = k.replace(/[.\-/]/g, '');
  if (/^\d{11}$/.test(digits) || /^\d{14}$/.test(digits)) return digits; // CPF ou CNPJ
  throw new PixConfigError('Chave Pix inválida (use e-mail, +55DDDNÚMERO, CPF, CNPJ ou chave aleatória).');
}

/** Identificador único da doação (até 25 caracteres alfanuméricos). */
export function newTxid() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.randomBytes(19);
  return 'DOAPET' + Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('');
}

/**
 * Monta o código Pix Copia e Cola.
 * @param {{ key: string, name: string, city: string, amountCents: number, txid: string, description?: string }} p
 */
export function buildPixPayload({ key, name, city, amountCents, txid, description }) {
  const merchantName = sanitize(name, 25);
  const merchantCity = sanitize(city, 15);
  if (!merchantName) throw new PixConfigError('Nome do recebedor Pix não configurado.');
  if (!merchantCity) throw new PixConfigError('Cidade do recebedor Pix não configurada.');
  if (!/^[A-Za-z0-9]{1,25}$/.test(txid)) throw new PixConfigError('txid inválido.');
  if (!Number.isSafeInteger(amountCents) || amountCents <= 0) throw new PixConfigError('Valor inválido.');

  const base = field('00', 'br.gov.bcb.pix') + field('01', normalizePixKey(key));
  // O campo 26 tem no máximo 99 caracteres; a descrição só entra se couber.
  const info = sanitize(description, 40);
  const withInfo = info ? base + field('02', info) : base;
  const account = withInfo.length <= 99 ? withInfo : base;

  const payload =
    field('00', '01') +
    field('26', account) +
    field('52', '0000') +
    field('53', '986') +
    field('54', (amountCents / 100).toFixed(2)) +
    field('58', 'BR') +
    field('59', merchantName) +
    field('60', merchantCity) +
    field('62', field('05', txid)) +
    '6304';
  return payload + crc16(payload);
}
