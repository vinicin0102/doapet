import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { isValidCpf, validateDonor } from '../public/js/shared/doacao.js';
import { extractWebhookIds, mapZuckPayStatus, verifyZuckPaySignature } from '../src/zuckpay.js';

const WEBHOOK_SECRET = 'whsec_teste';
const CLIENT_ID = 'cid_teste';
const CLIENT_SECRET = 'csec_teste';
const DOADOR = { nome: 'Maria da Silva', cpf: '529.982.247-25', email: 'maria@exemplo.com', telefone: '(11) 98765-4321' };

/** Simulador da API ZuckPay v3 (somente o que o site usa). */
function createFakeZuckPay() {
  const charges = new Map(); // external_id_client → { transactionId, valor, status }
  const calls = [];
  let nextId = 1;
  const json = (status, data) => new Response(JSON.stringify(data), { status });
  const fetchImpl = async (url, init) => {
    url = new URL(url);
    calls.push({ method: init.method, path: url.pathname, query: Object.fromEntries(url.searchParams), init });
    const expectedAuth = 'Basic ' + Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64');
    if (init.headers.Authorization !== expectedAuth) return json(401, { message: 'Credenciais inválidas' });
    if (init.method === 'POST' && url.pathname === '/conta/v3/pix/qrcode') {
      const body = JSON.parse(init.body);
      if (body.valor < 10) return json(400, { statusCode: 400, message: 'Valor mínimo para esta adquirente: R$ 10,00' });
      const charge = { transactionId: `ZP${nextId++}`, valor: body.valor, status: 'PENDING' };
      charges.set(body.external_id_client, charge);
      return json(200, { transactionId: charge.transactionId, qrcode: `00020126PIXFAKE${charge.transactionId}`, amount_liquid: body.valor * 0.97 });
    }
    if (init.method === 'GET' && url.pathname === '/conta/v3/pix/status') {
      const charge = charges.get(url.searchParams.get('external_id_client'));
      if (!charge) return json(400, { message: 'Transação não encontrada' });
      return json(200, { transactionId: charge.transactionId, status: charge.status, amount: charge.amount ?? charge.valor });
    }
    return json(405, { message: 'Método não permitido' });
  };
  return { charges, calls, fetchImpl };
}

let server;
let base;
const zuck = createFakeZuckPay();

before(async () => {
  const app = createApp({
    ...loadConfig({}),
    databaseUrl: process.env.TEST_DATABASE_URL || '',
    localDataDir: ':memory:',
    siteUrl: 'https://doapet.exemplo.org',
    zuckpay: {
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      webhookSecret: WEBHOOK_SECRET,
      baseUrl: 'https://www.zuckpay.com.br/conta',
    },
    fetchImpl: zuck.fetchImpl,
  });
  server = app.server;
  await app.ready();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
});

async function call(method, path, { body, raw, headers = {} } = {}) {
  const res = await fetch(base + path, {
    method,
    headers: { ...(body !== undefined || raw ? { 'Content-Type': 'application/json' } : {}), ...headers },
    body: raw ?? (body === undefined ? undefined : JSON.stringify(body)),
  });
  return { status: res.status, data: await res.json().catch(() => null) };
}

function sendWebhook(payload, { secret = WEBHOOK_SECRET, ts = Math.floor(Date.now() / 1000) } = {}) {
  const raw = JSON.stringify(payload);
  const v1 = crypto.createHmac('sha256', secret).update(`${ts}.${raw}`).digest('hex');
  return call('POST', '/api/zuckpay/webhook', {
    raw,
    headers: { 'X-ZuckPay-Timestamp': String(ts), 'X-ZuckPay-Signature': `t=${ts},v1=${v1}` },
  });
}

const raised = async () => (await call('GET', '/api/campanha')).data.arrecadado;
const donate = (valor, extra = {}) => call('POST', '/api/doacoes/pix', { body: { valor, ...DOADOR, ...extra } });

describe('dados do doador', () => {
  it('valida CPF pelos dígitos verificadores', () => {
    assert.equal(isValidCpf('529.982.247-25'), true);
    assert.equal(isValidCpf('529.982.247-26'), false);
    assert.equal(isValidCpf('111.111.111-11'), false);
    assert.equal(isValidCpf('123'), false);
  });

  it('normaliza os dados e aponta os campos inválidos', () => {
    assert.deepEqual(validateDonor(DOADOR).dados, {
      nome: 'Maria da Silva',
      cpf: '52998224725',
      email: 'maria@exemplo.com',
      telefone: '11987654321',
    });
    const { erros } = validateDonor({ nome: 'Maria', cpf: '1', email: 'x', telefone: '123' });
    assert.deepEqual(Object.keys(erros).sort(), ['cpf', 'email', 'nome', 'telefone']);
  });
});

describe('webhook ZuckPay: utilitários', () => {
  it('valida a assinatura t=…,v1=… e rejeita timestamps antigos', () => {
    const raw = Buffer.from('{"transactionId":"ZP1"}');
    const ts = 1_800_000_000;
    const v1 = crypto.createHmac('sha256', 's').update(`${ts}.${raw}`).digest('hex');
    const header = `t=${ts},v1=${v1}`;
    assert.equal(verifyZuckPaySignature(raw, header, 's', { nowSeconds: ts + 10 }), true);
    assert.equal(verifyZuckPaySignature(raw, header, 's', { nowSeconds: ts + 301 }), false);
    assert.equal(verifyZuckPaySignature(raw, header, 'outro', { nowSeconds: ts }), false);
    assert.equal(verifyZuckPaySignature(Buffer.from('{}'), header, 's', { nowSeconds: ts }), false);
    assert.equal(verifyZuckPaySignature(raw, undefined, 's'), false);
  });

  it('encontra os IDs no corpo, inclusive aninhados', () => {
    assert.deepEqual(extractWebhookIds({ data: { external_id_client: 'DOAPETX', transactionId: 123 } }), {
      externalId: 'DOAPETX',
      transactionId: '123',
    });
    assert.deepEqual(extractWebhookIds({ id: 'a b' }), { externalId: undefined, transactionId: undefined });
  });

  it('só considera pago o status PAID', () => {
    assert.equal(mapZuckPayStatus('PAID'), 'confirmada');
    assert.equal(mapZuckPayStatus('refunded'), 'devolvida');
    for (const s of ['PENDING', 'WAITING_PAYMENT', 'EXPIRADO', 'FAILED', 'REFUSED', undefined]) {
      assert.equal(mapZuckPayStatus(s), 'pendente');
    }
  });
});

describe('quadro de doações com ZuckPay', () => {
  let donation;

  it('informa à página que os pagamentos passam pela ZuckPay', async () => {
    const res = await call('GET', '/api/doacoes/config');
    assert.equal(res.data.provedor, 'zuckpay');
    assert.deepEqual(res.data.valores, [5, 10, 15, 25, 30, 50, 100]);
    assert.equal(res.data.maisEscolhido, 50);
  });

  it('exige dados válidos do doador antes de chamar a ZuckPay', async () => {
    const before = zuck.calls.length;
    const res = await call('POST', '/api/doacoes/pix', { body: { valor: 50, ...DOADOR, cpf: '111.111.111-11' } });
    assert.equal(res.status, 400);
    assert.ok(res.data.campos.cpf);
    assert.equal((await donate(7)).status, 400);
    assert.equal(zuck.calls.length, before);
  });

  it('cria a cobrança com external_id_client, urlnoty e autenticação Basic', async () => {
    const res = await donate(50);
    assert.equal(res.status, 200);
    donation = res.data;
    assert.match(donation.id, /^DOAPET[A-Z0-9]{19}$/);
    assert.match(donation.copiaECola, /^00020126PIXFAKE/);
    assert.match(donation.qrCode, /^data:image\/png;base64,/);

    const sent = JSON.parse(zuck.calls.at(-1).init.body);
    assert.deepEqual(sent, {
      nome: 'Maria da Silva',
      cpf: '52998224725',
      email: 'maria@exemplo.com',
      telefone: '11987654321',
      valor: 50,
      descricao: 'Doação — campanha da ração',
      external_id_client: donation.id,
      urlnoty: 'https://doapet.exemplo.org/api/zuckpay/webhook',
    });
    assert.equal(zuck.calls.at(-1).init.redirect, 'error');
    // Cobrança gerada não é dinheiro recebido.
    assert.equal(await raised(), 0);
    assert.equal((await call('GET', `/api/doacoes/status?id=${donation.id}`)).data.status, 'pendente');
  });

  it('mostra a mensagem da ZuckPay quando ela recusa o valor', async () => {
    const res = await donate(5);
    assert.equal(res.status, 400);
    assert.match(res.data.erro, /mínimo/);
  });

  it('rejeita postback sem assinatura válida ou com timestamp antigo', async () => {
    zuck.charges.get(donation.id).status = 'PAID';
    const raw = JSON.stringify({ external_id_client: donation.id, status: 'PAID' });
    assert.equal((await call('POST', '/api/zuckpay/webhook', { raw })).status, 401);
    assert.equal((await sendWebhook({ external_id_client: donation.id }, { secret: 'errado' })).status, 401);
    const old = Math.floor(Date.now() / 1000) - 3600;
    assert.equal((await sendWebhook({ external_id_client: donation.id }, { ts: old })).status, 401);
    assert.equal(await raised(), 0);
  });

  it('confirma o pagamento consultando a ZuckPay e soma uma única vez', async () => {
    const res = await sendWebhook({ transactionId: zuck.charges.get(donation.id).transactionId, status: 'PAID' });
    assert.equal(res.status, 200);
    assert.equal(res.data.status, 'confirmada');
    assert.equal(await raised(), 50);
    await sendWebhook({ external_id_client: donation.id, status: 'PAID' }); // reenvio
    assert.equal(await raised(), 50);
    assert.equal((await call('GET', `/api/doacoes/status?id=${donation.id}`)).data.status, 'confirmada');
  });

  it('não confia no status do corpo do postback', async () => {
    const other = (await donate(100)).data;
    const res = await sendWebhook({ external_id_client: other.id, status: 'PAID' }); // ZuckPay ainda diz PENDING
    assert.equal(res.data.status, 'pendente');
    assert.equal(await raised(), 50);
  });

  it('não conta pagamento com valor diferente do cobrado', async () => {
    const other = (await donate(30)).data;
    Object.assign(zuck.charges.get(other.id), { status: 'PAID', amount: 0.3 });
    await sendWebhook({ external_id_client: other.id });
    assert.equal(await raised(), 50);
  });

  it('ignora vendas da conta que não são doações do site', async () => {
    const res = await sendWebhook({ external_id_client: 'PEDIDO-123', transactionId: 'ZP999', status: 'PAID' });
    assert.equal(res.data.ignorado, true);
    assert.equal(await raised(), 50);
  });

  it('a consulta de status da página também confirma o pagamento, sem webhook', async () => {
    const other = (await donate(25)).data;
    zuck.charges.get(other.id).status = 'PAID';
    // Respeita o intervalo mínimo entre consultas à ZuckPay.
    assert.equal((await call('GET', `/api/doacoes/status?id=${other.id}`)).data.status, 'pendente');
    await new Promise((r) => setTimeout(r, 8100));
    assert.equal((await call('GET', `/api/doacoes/status?id=${other.id}`)).data.status, 'confirmada');
    assert.equal(await raised(), 75);
    assert.equal((await call('GET', '/api/doacoes/status?id=../../etc')).status, 400);
  });

  it('desconta doações estornadas', async () => {
    zuck.charges.get(donation.id).status = 'REFUNDED';
    const res = await sendWebhook({ external_id_client: donation.id });
    assert.equal(res.data.status, 'devolvida');
    assert.equal(await raised(), 25);
  });
});
