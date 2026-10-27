import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { getPayloadFromClientToken } from '@vercel/blob/client';
import { createApp } from '../src/app.js';
import { createBlobStorage, parseStoreId } from '../src/blob.js';
import { loadConfig } from '../src/config.js';

const HOST = 'loja123.public.blob.vercel-storage.com';
// Arquivos "enviados" ao Blob simulado: url → { size, contentType, pathname }.
const files = new Map();
const deleted = [];

const storage = {
  // Geração real do token de upload (criptografia local, sem rede).
  ...createBlobStorage('vercel_blob_rw_LOJA123_segredodeteste'),
  head: async (url) => {
    const info = files.get(url);
    if (!info) throw new Error('not found');
    return info;
  },
  del: async (url) => {
    deleted.push(url);
    files.delete(url);
  },
};

function fakeUpload(name, contentType, size) {
  const url = `https://${HOST}/midias/${name}`;
  files.set(url, { size, contentType, pathname: `midias/${name}` });
  return url;
}

let server;
let base;
let admin;

before(async () => {
  const app = createApp({
    ...loadConfig({}),
    databaseUrl: process.env.TEST_DATABASE_URL || '',
    localDataDir: ':memory:',
    bootstrapAdmin: { username: 'admin', password: 'senha-super-segura' },
    blobStorage: storage,
  });
  server = app.server;
  await app.ready();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  const res = await fetch(`${base}/api/admin/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ usuario: 'admin', senha: 'senha-super-segura' }),
  });
  admin = { cookie: res.headers.get('set-cookie').split(';')[0], csrf: (await res.json()).csrfToken };
});

after(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
});

async function call(method, path, { body, auth = true } = {}) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (auth) Object.assign(headers, { Cookie: admin.cookie, 'X-CSRF-Token': admin.csrf });
  const res = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, data: await res.json().catch(() => null) };
}

const tokenRequest = (pathname) => ({
  type: 'blob.generate-client-token',
  payload: { pathname, clientPayload: null, multipart: false },
});

describe('imagens e vídeos da página', () => {
  it('lê o ID da loja a partir do token do Blob', () => {
    assert.equal(parseStoreId('vercel_blob_rw_AbC123_xyz'), 'abc123');
    assert.equal(parseStoreId('outro'), null);
    assert.equal(storage.publicHost, HOST);
  });

  it('página pública começa sem mídias', async () => {
    const res = await call('GET', '/api/midias', { auth: false });
    assert.deepEqual(res.data, { topo: [], campanha: [], doacao: [], sobre: [], galeria: [] });
  });

  it('só administradores obtêm token de envio, com tipo e tamanho limitados', async () => {
    assert.equal((await call('POST', '/api/admin/midias/token', { body: tokenRequest('midias/foto.jpg'), auth: false })).status, 401);

    const res = await call('POST', '/api/admin/midias/token', { body: tokenRequest('midias/foto.jpg') });
    assert.equal(res.status, 200);
    const payload = getPayloadFromClientToken(res.data.clientToken);
    assert.equal(payload.pathname, 'midias/foto.jpg');
    assert.deepEqual(payload.allowedContentTypes, ['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
    assert.equal(payload.maximumSizeInBytes, 15 * 1024 * 1024);

    const video = await call('POST', '/api/admin/midias/token', { body: tokenRequest('midias/abrigo.mp4') });
    assert.equal(getPayloadFromClientToken(video.data.clientToken).maximumSizeInBytes, 200 * 1024 * 1024);

    assert.equal((await call('POST', '/api/admin/midias/token', { body: tokenRequest('midias/virus.exe') })).status, 400);
    assert.equal((await call('POST', '/api/admin/midias/token', { body: tokenRequest('outra/foto.jpg') })).status, 400);
    assert.equal((await call('POST', '/api/admin/midias/token', { body: tokenRequest('midias/../x.jpg') })).status, 400);
  });

  let fotoId;
  let videoId;

  it('registra o arquivo enviado com tipo e tamanho lidos do próprio Blob', async () => {
    const url = fakeUpload('cachorros-abc.jpg', 'image/jpeg', 300_000);
    const res = await call('POST', '/api/admin/midias', {
      body: { url, local: 'topo', legenda: 'Nossos resgatados', alt: 'Cães no abrigo' },
    });
    assert.equal(res.status, 201);
    fotoId = res.data.id;
    assert.equal(res.data.tipo, 'imagem');

    const video = await call('POST', '/api/admin/midias', {
      body: { url: fakeUpload('abrigo-x.mp4', 'video/mp4', 50_000_000), local: 'topo' },
    });
    videoId = video.data.id;

    const pub = (await call('GET', '/api/midias', { auth: false })).data;
    assert.deepEqual(pub.topo.map((m) => [m.id, m.tipo, m.legenda]), [
      [fotoId, 'imagem', 'Nossos resgatados'],
      [videoId, 'video', null],
    ]);
  });

  it('recusa arquivos de outros endereços, locais inválidos e tamanhos acima do limite', async () => {
    const foreign = await call('POST', '/api/admin/midias', {
      body: { url: 'https://outro-site.com/midias/x.jpg', local: 'topo' },
    });
    assert.equal(foreign.status, 400);
    const badSlot = await call('POST', '/api/admin/midias', {
      body: { url: fakeUpload('a.jpg', 'image/jpeg', 10), local: 'rodape' },
    });
    assert.equal(badSlot.status, 400);
    // O navegador poderia mentir o tamanho; o servidor confere no Blob e apaga o excesso.
    const bigUrl = fakeUpload('gigante.png', 'image/png', 16 * 1024 * 1024);
    assert.equal((await call('POST', '/api/admin/midias', { body: { url: bigUrl, local: 'topo' } })).status, 400);
    assert.ok(deleted.includes(bigUrl));
    const missing = await call('POST', '/api/admin/midias', {
      body: { url: `https://${HOST}/midias/nao-existe.jpg`, local: 'topo' },
    });
    assert.equal(missing.status, 400);
    assert.equal((await call('POST', '/api/admin/midias', { body: { url: 'x', local: 'topo' }, auth: false })).status, 401);
  });

  it('reordena dentro do local e move para outro local', async () => {
    await call('POST', `/api/admin/midias/${videoId}/mover`, { body: { direcao: 'cima' } });
    let pub = (await call('GET', '/api/midias', { auth: false })).data;
    assert.deepEqual(pub.topo.map((m) => m.id), [videoId, fotoId]);

    const res = await call('PUT', `/api/admin/midias/${fotoId}`, {
      body: { local: 'galeria', legenda: 'Hora da ração', alt: 'Cães comendo' },
    });
    assert.equal(res.status, 200);
    pub = (await call('GET', '/api/midias', { auth: false })).data;
    assert.deepEqual(pub.topo.map((m) => m.id), [videoId]);
    assert.equal(pub.galeria[0].legenda, 'Hora da ração');
  });

  it('remove da página, apaga o arquivo e registra no histórico', async () => {
    const list = (await call('GET', '/api/admin/midias')).data;
    assert.equal(list.disponivel, true);
    const video = list.midias.find((m) => m.id === videoId);
    assert.equal((await call('DELETE', `/api/admin/midias/${videoId}`)).status, 200);
    assert.ok(deleted.includes(video.url));
    assert.equal((await call('DELETE', `/api/admin/midias/${videoId}`)).status, 404);

    const acoes = (await call('GET', '/api/admin/historico')).data.map((h) => h.acao);
    assert.ok(acoes.includes('midia_adicionada'));
    assert.ok(acoes.includes('midia_atualizada'));
    assert.ok(acoes.includes('midia_removida'));
  });

  it('visitantes não alteram mídias', async () => {
    assert.equal((await call('PUT', `/api/admin/midias/${fotoId}`, { body: { local: 'topo' }, auth: false })).status, 401);
    assert.equal((await call('DELETE', `/api/admin/midias/${fotoId}`, { auth: false })).status, 401);
  });
});
