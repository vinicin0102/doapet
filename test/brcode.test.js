import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { PixConfigError, buildPixPayload, crc16, newTxid, normalizePixKey } from '../src/brcode.js';

/** Lê o BR Code (formato ID + tamanho + valor) em um objeto. */
function parseTlv(s) {
  const out = {};
  for (let i = 0; i < s.length; ) {
    const id = s.slice(i, i + 2);
    const len = Number(s.slice(i + 2, i + 4));
    out[id] = s.slice(i + 4, i + 4 + len);
    i += 4 + len;
  }
  return out;
}

describe('BR Code Pix', () => {
  it('calcula o CRC16 do exemplo oficial do Banco Central', () => {
    const exemplo =
      '00020126580014br.gov.bcb.pix0136123e4567-e12b-12d1-a456-426655440000' +
      '5204000053039865802BR5913Fulano de Tal6008BRASILIA62070503***6304';
    assert.equal(crc16(exemplo), '1D3D');
  });

  it('monta o Pix Copia e Cola com valor, recebedor e txid', () => {
    const payload = buildPixPayload({
      key: 'Doacoes@NossaONG.org',
      name: 'Associação Nossa ONG de Proteção Animal',
      city: 'São José dos Campos',
      amountCents: 5000,
      txid: 'DOAPET123',
      description: 'Doacao racao',
    });
    const f = parseTlv(payload);
    assert.equal(f['00'], '01');
    assert.equal(f['52'], '0000');
    assert.equal(f['53'], '986');
    assert.equal(f['54'], '50.00');
    assert.equal(f['58'], 'BR');
    assert.equal(f['59'], 'ASSOCIACAO NOSSA ONG DE P'); // sem acentos, máx. 25
    assert.equal(f['60'], 'SAO JOSE DOS CA'); // máx. 15
    assert.deepEqual(parseTlv(f['26']), {
      '00': 'br.gov.bcb.pix',
      '01': 'doacoes@nossaong.org',
      '02': 'DOACAO RACAO',
    });
    assert.deepEqual(parseTlv(f['62']), { '05': 'DOAPET123' });
    assert.equal(f['63'], crc16(payload.slice(0, -4)));
  });

  it('aceita os tipos de chave Pix e rejeita chaves inválidas', () => {
    assert.equal(normalizePixKey('12.345.678/0001-95'), '12345678000195');
    assert.equal(normalizePixKey('123.456.789-09'), '12345678909');
    assert.equal(normalizePixKey('+5511987654321'), '+5511987654321');
    assert.equal(normalizePixKey('123E4567-E12B-12D1-A456-426655440000'), '123e4567-e12b-12d1-a456-426655440000');
    for (const bad of ['', 'abc', '11987654321x', '+1 555 0100']) {
      assert.throws(() => normalizePixKey(bad), PixConfigError);
    }
  });

  it('gera txid único com até 25 caracteres alfanuméricos', () => {
    const a = newTxid();
    assert.match(a, /^[A-Z0-9]{25}$/);
    assert.notEqual(a, newTxid());
  });
});
