// Utilitários de dinheiro. Todos os valores são tratados em CENTAVOS (inteiros)
// para evitar erros de arredondamento de ponto flutuante.

export const MAX_CENTS = 10_000_000_000; // R$ 100.000.000,00 — limite de sanidade

export class MoneyError extends Error {}

/**
 * Converte um valor digitado pelo administrador em centavos.
 * Aceita: 1750 | 1750.5 | "1750" | "1750,00" | "1.750,00" | "R$ 1.750,00" | "1750.00"
 * Rejeita: negativos, mais de 2 casas decimais, texto inválido, NaN/Infinity.
 */
export function parseBRL(input, { allowZero = true } = {}) {
  let cents;
  if (typeof input === 'number') {
    if (!Number.isFinite(input)) throw new MoneyError('Valor inválido.');
    cents = Math.round(input * 100);
    if (Math.abs(cents / 100 - input) > 1e-9) {
      throw new MoneyError('Use no máximo 2 casas decimais.');
    }
  } else if (typeof input === 'string') {
    let s = input.trim().replace(/^R\$\s*/i, '').replace(/\s/g, '');
    if (s === '') throw new MoneyError('Informe um valor.');
    if (s.startsWith('-')) throw new MoneyError('O valor não pode ser negativo.');
    if (s.includes(',')) {
      // Formato brasileiro: pontos são separadores de milhar, vírgula é decimal.
      if (!/^\d{1,3}(\.\d{3})*(,\d{1,2})?$|^\d+(,\d{1,2})?$/.test(s)) {
        throw new MoneyError('Valor inválido. Exemplo: 1.750,00');
      }
      s = s.replace(/\./g, '').replace(',', '.');
    } else if (/^\d{1,3}(\.\d{3})+$/.test(s)) {
      // "1.750" ou "1.000.000" sem vírgula: pontos como separador de milhar.
      s = s.replace(/\./g, '');
    } else if (!/^\d+(\.\d{1,2})?$/.test(s)) {
      throw new MoneyError('Valor inválido. Exemplo: 1.750,00');
    }
    const [int, dec = ''] = s.split('.');
    cents = Number(int) * 100 + Number(dec.padEnd(2, '0'));
  } else {
    throw new MoneyError('Informe um valor.');
  }

  if (!Number.isSafeInteger(cents)) throw new MoneyError('Valor inválido.');
  if (cents < 0) throw new MoneyError('O valor não pode ser negativo.');
  if (!allowZero && cents === 0) throw new MoneyError('O valor deve ser maior que zero.');
  if (cents > MAX_CENTS) throw new MoneyError('Valor acima do limite permitido.');
  return cents;
}

/**
 * Converte valores vindos do provedor Pix (padrão do Banco Central: string com
 * ponto decimal, ex. "25.90") em centavos. Mais estrito que parseBRL.
 */
export function parsePixAmount(input) {
  const s = typeof input === 'number' ? input.toFixed(2) : String(input ?? '').trim();
  if (!/^\d+(\.\d{1,2})?$/.test(s)) throw new MoneyError('Valor Pix inválido.');
  const [int, dec = ''] = s.split('.');
  const cents = Number(int) * 100 + Number(dec.padEnd(2, '0'));
  if (!Number.isSafeInteger(cents) || cents <= 0 || cents > MAX_CENTS) {
    throw new MoneyError('Valor Pix inválido.');
  }
  return cents;
}

export function formatBRL(cents) {
  // Troca o espaço não separável do Intl por um espaço comum (texto do histórico).
  return (cents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }).replace(/\s/g, ' ');
}
