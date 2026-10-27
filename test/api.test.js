import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';

const SECRET = 'segredo-de-teste';
let server;
let base;

before(async () => {
  const config = {
    ...loadConfig({}),
    // TEST_DATABASE_URL permite rodar os mesmos testes contra um Postgres real.
    databaseUrl: process.env.TEST_DATABASE_URL || '',
    localDataDir: ':memory:',
    pixWebhookSecret: SECRET,
    bootstrapAdmin: { username: 'admin', password: 'senha-super-segura' },
  };
  const app = createApp(config);
  server = app.server;
  await app.ready();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
});

async function request(method, url, { body, cookie, csrf, headers = {}, raw } = {}) {
  const h = { ...headers };
  if (body !== undefined) h['Content-Type'] = 'application/json';
  if (cookie) h.Cookie = cookie;
  if (csrf) h['X-CSRF-Token'] = csrf;
  const res = await fetch(base + url, {
    method,
    headers: h,
    body: raw ?? (body === undefined ? undefined : JSON.stringify(body)),
  });
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  return { status: res.status, data, headers: res.headers };
}

async function login() {
  const res = await request('POST', '/api/admin/login', { body: { usuario: 'admin', senha: 'senha-super-segura' } });
  assert.equal(res.status, 200);
  const cookie = res.headers.get('set-cookie').split(';')[0];
  return { cookie, csrf: res.data.csrfToken };
}

function sendPix(payload) {
  const raw = JSON.stringify(payload);
  const sig = crypto.createHmac('sha256', SECRET).update(raw).digest('hex');
  return request('POST', '/api/pix/webhook', {
    raw,
    headers: { 'Content-Type': 'application/json', 'X-Pix-Signature': `sha256=${sig}` },
  });
}

describe('API da campanha', () => {
  let admin;
  let version;

  const state = async () => (await request('GET', '/api/admin/campanha', admin)).data;
  const save = (body) => request('PUT', '/api/admin/campanha', { ...admin, body: { versao: version, ...body } });

  it('começa com meta de R$ 5.000,00 e nenhum valor fictício', async () => {
    const res = await request('GET', '/api/campanha');
    assert.equal(res.status, 200);
    assert.equal(res.data.meta, 5000);
    assert.equal(res.data.arrecadado, 0);
    assert.equal(res.data.falta, 5000);
    assert.equal(res.data.percentual, 0);
    assert.equal(res.data.modo, 'automatico');
  });

  it('visitantes não conseguem alterar valores', async () => {
    const put = await request('PUT', '/api/admin/campanha', {
      body: { versao: 1, meta: '10', modo: 'manual', valorManual: '9999', origemManual: 'hack' },
    });
    assert.equal(put.status, 401);
    const get = await request('GET', '/api/admin/campanha');
    assert.equal(get.status, 401);
    const contrib = await request('POST', '/api/admin/contribuicoes', { body: { valor: '10' } });
    assert.equal(contrib.status, 401);
    assert.equal((await request('GET', '/api/campanha')).data.arrecadado, 0);
  });

  it('rejeita senha errada', async () => {
    const res = await request('POST', '/api/admin/login', { body: { usuario: 'admin', senha: 'errada-errada' } });
    assert.equal(res.status, 401);
  });

  it('exige token CSRF para alterações', async () => {
    admin = await login();
    version = (await state()).versao;
    const res = await request('PUT', '/api/admin/campanha', {
      cookie: admin.cookie,
      body: { versao: version, meta: '5000', modo: 'automatico' },
    });
    assert.equal(res.status, 403);
  });

  it('no modo automático, bloqueia edição manual do valor arrecadado', async () => {
    const res = await save({ meta: '5.000,00', modo: 'automatico', valorManual: '1.750,00' });
    assert.equal(res.status, 422);
    assert.equal(res.data.codigo, 'EDICAO_MANUAL_BLOQUEADA');
  });

  it('conta somente Pix confirmados, sem duplicidade', async () => {
    assert.equal((await sendPix({ txid: 'TXPENDENTE', valor: '100.00', status: 'ATIVA' })).status, 200);
    assert.equal((await request('GET', '/api/campanha')).data.arrecadado, 0);

    const payload = { pix: [{ endToEndId: 'E0001', txid: 'TX0001', valor: '250.00', horario: '2026-10-27T10:00:00Z' }] };
    assert.equal((await sendPix(payload)).status, 200);
    assert.equal((await sendPix(payload)).status, 200); // reenvio do provedor
    assert.equal((await request('GET', '/api/campanha')).data.arrecadado, 250);

    // Evento "pendente" atrasado não desfaz a confirmação.
    await sendPix({ txid: 'TX0001', valor: '250.00', status: 'ATIVA' });
    assert.equal((await request('GET', '/api/campanha')).data.arrecadado, 250);
  });

  it('rejeita webhook sem assinatura válida', async () => {
    const res = await request('POST', '/api/pix/webhook', {
      body: { txid: 'FAKE', valor: '1000.00', status: 'CONCLUIDA' },
      headers: { 'X-Pix-Signature': 'sha256=' + '0'.repeat(64) },
    });
    assert.equal(res.status, 401);
    assert.equal((await request('GET', '/api/campanha')).data.arrecadado, 250);
  });

  it('desconta devoluções de Pix', async () => {
    await sendPix({
      pix: [{ endToEndId: 'E0002', txid: 'TX0002', valor: '50.00', devolucoes: [{ valor: '50.00', status: 'DEVOLVIDO' }] }],
    });
    assert.equal((await request('GET', '/api/campanha')).data.arrecadado, 250);
  });

  it('modo manual exige confirmação e origem, e atualiza a barra pública (exemplo R$ 1.750,00 = 35%)', async () => {
    version = (await state()).versao;
    const semOrigem = await save({ meta: '5.000,00', modo: 'manual', valorManual: '1.750,00', confirmarModoManual: true });
    assert.equal(semOrigem.status, 400);

    const body = { meta: '5.000,00', modo: 'manual', valorManual: '1.750,00', origemManual: 'Extrato bancário + Pix' };
    const semConfirmacao = await save(body);
    assert.equal(semConfirmacao.status, 409);
    assert.equal(semConfirmacao.data.codigo, 'CONFIRMACAO_NECESSARIA');

    const ok = await save({ ...body, confirmarModoManual: true });
    assert.equal(ok.status, 200);
    assert.equal(ok.data.alterado, true);

    const pub = (await request('GET', '/api/campanha')).data;
    assert.equal(pub.arrecadado, 1750);
    assert.equal(pub.meta, 5000);
    assert.equal(pub.percentual, 35);
    assert.equal(pub.percentualBarra, 35);
    assert.equal(pub.falta, 3250);
  });

  it('rejeita versão desatualizada (edição simultânea)', async () => {
    const res = await save({ meta: '5000', modo: 'manual', valorManual: '1000', origemManual: 'teste' });
    assert.equal(res.status, 409);
    assert.equal(res.data.codigo, 'VERSAO_DESATUALIZADA');
  });

  it('valida valores no backend', async () => {
    version = (await state()).versao;
    for (const body of [
      { meta: '0', modo: 'manual', valorManual: '10', origemManual: 'abc' },
      { meta: '-5000', modo: 'manual', valorManual: '10', origemManual: 'abc' },
      { meta: '5000', modo: 'manual', valorManual: '-10', origemManual: 'abc' },
      { meta: '5000', modo: 'manual', valorManual: 'muito', origemManual: 'abc' },
      { meta: '5000', modo: 'invalido' },
    ]) {
      const res = await save(body);
      assert.equal(res.status, 400, JSON.stringify(body));
    }
  });

  it('meta ultrapassada: mostra valor real e limita a barra a 100%', async () => {
    const res = await save({ meta: '5000', modo: 'manual', valorManual: '6.000,00', origemManual: 'Extrato' });
    assert.equal(res.status, 200);
    version = res.data.estado.versao;
    const pub = (await request('GET', '/api/campanha')).data;
    assert.equal(pub.arrecadado, 6000);
    assert.equal(pub.falta, 0);
    assert.equal(pub.percentual, 120);
    assert.equal(pub.percentualBarra, 100);
    assert.equal(pub.metaAtingida, true);
  });

  it('modo híbrido soma Pix confirmados e contribuições externas sem duplicidade', async () => {
    const res = await save({ meta: '5000', modo: 'hibrido' });
    assert.equal(res.status, 200);
    version = res.data.estado.versao;

    const add = (body) => request('POST', '/api/admin/contribuicoes', { ...admin, body });
    const c1 = await add({ valor: '300,00', origem: 'transferencia', dataRecebimento: '2026-10-01', referencia: 'TED-1' });
    assert.equal(c1.status, 201);
    assert.equal((await add({ valor: '300,00', origem: 'deposito', dataRecebimento: '2026-10-01', referencia: 'ted-1' })).status, 409);
    // Referência igual a um Pix já contado automaticamente.
    assert.equal((await add({ valor: '250,00', origem: 'pix_direto', dataRecebimento: '2026-10-01', referencia: 'E0001' })).status, 409);
    assert.equal((await add({ valor: '10', origem: 'invalida', dataRecebimento: '2026-10-01' })).status, 400);
    assert.equal((await add({ valor: '10', origem: 'dinheiro', dataRecebimento: '2999-01-01' })).status, 400);

    let pub = (await request('GET', '/api/campanha')).data;
    assert.equal(pub.arrecadado, 550); // 250 Pix + 300 externo

    const del = await request('DELETE', `/api/admin/contribuicoes/${c1.data.id}`, {
      ...admin,
      body: { motivo: 'Lançado em duplicidade' },
    });
    assert.equal(del.status, 200);
    pub = (await request('GET', '/api/campanha')).data;
    assert.equal(pub.arrecadado, 250);
  });

  it('registra o histórico com data, administrador e valores anteriores', async () => {
    const res = await request('GET', '/api/admin/historico', admin);
    assert.equal(res.status, 200);
    const acoes = res.data.map((h) => h.acao);
    assert.ok(acoes.includes('configuracao_atualizada'));
    assert.ok(acoes.includes('contribuicao_registrada'));
    assert.ok(acoes.includes('contribuicao_removida'));
    const manual = res.data.find((h) => h.valoresNovos?.valorManual === 'R$ 1.750,00');
    assert.ok(manual);
    assert.equal(manual.administrador, 'admin');
    assert.equal(manual.valoresAnteriores.modo, 'automatico');
    assert.equal(manual.valoresAnteriores.arrecadadoExibido, 'R$ 250,00');
    assert.ok(!Number.isNaN(Date.parse(manual.data)));
  });

  it('logout invalida a sessão', async () => {
    assert.equal((await request('POST', '/api/admin/logout', admin)).status, 200);
    assert.equal((await request('GET', '/api/admin/campanha', admin)).status, 401);
  });

  it('serve a página pública e os módulos compartilhados, sem expor arquivos fora de public/', async () => {
    assert.equal((await request('GET', '/')).status, 200);
    assert.equal((await request('GET', '/admin/')).status, 200);
    assert.equal((await request('GET', '/js/shared/money.js')).status, 200);
    const res = await fetch(`${base}/%2e%2e/package.json`);
    assert.notEqual(res.status, 200);
  });
});
