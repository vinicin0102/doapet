import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { describe, it } from 'node:test';
import { MoneyError, parseBRL, parsePixAmount } from '../public/js/shared/money.js';
import { normalizePixPayload, verifySignature } from '../src/pix.js';
import { computeProgress, raisedForMode } from '../public/js/shared/progress.js';

describe('parseBRL', () => {
  it('aceita formatos brasileiros e numéricos', () => {
    assert.equal(parseBRL('1.750,00'), 175000);
    assert.equal(parseBRL('R$ 1.750,00'), 175000);
    assert.equal(parseBRL('1750'), 175000);
    assert.equal(parseBRL('1750,5'), 175050);
    assert.equal(parseBRL('1750.50'), 175050);
    assert.equal(parseBRL('1.750'), 175000);
    assert.equal(parseBRL('5.000.000,00'), 500000000);
    assert.equal(parseBRL(1750), 175000);
    assert.equal(parseBRL(0.1), 10);
    assert.equal(parseBRL('0'), 0);
  });

  it('rejeita valores inválidos', () => {
    for (const bad of ['-10', '-1,00', 'abc', '', '1,234', '1.75.0', '10,999', 'NaN', '1e5', null, {}, -5, NaN, Infinity, 1.005]) {
      assert.throws(() => parseBRL(bad), MoneyError, `deveria rejeitar ${String(bad)}`);
    }
    assert.throws(() => parseBRL('0', { allowZero: false }), MoneyError);
    assert.throws(() => parseBRL('999999999999'), MoneyError);
  });
});

describe('parsePixAmount', () => {
  it('aceita o formato do Banco Central', () => {
    assert.equal(parsePixAmount('25.90'), 2590);
    assert.equal(parsePixAmount('100'), 10000);
  });
  it('rejeita zero, negativos e vírgula', () => {
    for (const bad of ['0.00', '-1.00', '1,00', '', 'x']) assert.throws(() => parsePixAmount(bad), MoneyError);
  });
});

describe('computeProgress', () => {
  it('calcula o exemplo do enunciado (R$ 1.750 de R$ 5.000 = 35%)', () => {
    const p = computeProgress(500000, 175000);
    assert.deepEqual(p, {
      goalCents: 500000,
      raisedCents: 175000,
      remainingCents: 325000,
      percent: 35,
      barPercent: 35,
      goalReached: false,
    });
  });

  it('limita a barra a 100% quando a meta é ultrapassada, mantendo o valor real', () => {
    const p = computeProgress(500000, 600000);
    assert.equal(p.raisedCents, 600000);
    assert.equal(p.remainingCents, 0);
    assert.equal(p.percent, 120);
    assert.equal(p.barPercent, 100);
    assert.equal(p.goalReached, true);
  });

  it('nunca fica negativo', () => {
    const p = computeProgress(500000, -100);
    assert.equal(p.percent, 0);
    assert.equal(p.barPercent, 0);
    assert.equal(p.remainingCents, 500000);
  });

  it('não exibe 100% antes de atingir a meta', () => {
    const p = computeProgress(500000, 499999);
    assert.equal(p.percent, 99.9);
    assert.equal(p.goalReached, false);
  });
});

describe('raisedForMode', () => {
  const totals = { pixCents: 1000, manualCents: 5000, externalCents: 300 };
  it('usa a fonte correta em cada modo', () => {
    assert.equal(raisedForMode('automatico', totals), 1000);
    assert.equal(raisedForMode('manual', totals), 5000);
    assert.equal(raisedForMode('hibrido', totals), 1300);
  });
});

describe('webhook Pix', () => {
  it('verifica a assinatura HMAC', () => {
    const body = Buffer.from('{"a":1}');
    const sig = crypto.createHmac('sha256', 'segredo').update(body).digest('hex');
    assert.equal(verifySignature(body, `sha256=${sig}`, 'segredo'), true);
    assert.equal(verifySignature(body, `sha256=${sig}`, 'outro'), false);
    assert.equal(verifySignature(body, 'sha256=xyz', 'segredo'), false);
    assert.equal(verifySignature(body, undefined, 'segredo'), false);
    assert.equal(verifySignature(body, `sha256=${sig}`, ''), false);
  });

  it('normaliza o formato do Banco Central com devoluções', () => {
    const [e] = normalizePixPayload({
      pix: [
        {
          endToEndId: 'E123',
          txid: 'TX1',
          valor: '50.00',
          horario: '2026-10-27T10:00:00Z',
          devolucoes: [{ valor: '10.00', status: 'DEVOLVIDO' }, { valor: '5.00', status: 'EM_PROCESSAMENTO' }],
        },
      ],
    });
    assert.deepEqual(e, {
      txid: 'TX1',
      e2eId: 'E123',
      amountCents: 5000,
      refundedCents: 1000,
      status: 'confirmada',
      paidAt: '2026-10-27T10:00:00Z',
    });
  });

  it('trata status desconhecido como pendente', () => {
    const [e] = normalizePixPayload({ txid: 'TX2', valor: '10.00', status: 'ATIVA' });
    assert.equal(e.status, 'pendente');
  });
});
