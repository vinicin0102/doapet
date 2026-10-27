import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { createSupabaseStorage } from '../src/storage-supabase.js';

const SUPABASE = 'https://abcdefgh.supabase.co';
// Arquivos "enviados" ao armazenamento simulado: caminho → { size, contentType }.
const files = new Map();
const deleted = [];
const signed = [];

const storage = {
  publicUrl: (path) => `${SUPABASE}/storage/v1/object/public/midias/${path}`,
  createUpload: async (path) => {
    signed.push(path);
    return { uploadUrl: `${SUPABASE}/storage/v1/object/upload/sign/midias/${path}?token=t` };
  },
  head: async (path) => {
    const info = files.get(path);
    if (!info) throw new Error('not found');
    return info;
  },
  del: async (path) => {
    deleted.push(path);
    files.delete(path);
  },
};

/** Simula o navegador: pede a URL assinada e "envia" o arquivo. */
async function upload(nome, contentType, size, realSize = size) {
  const res = await call('POST', '/api/admin/midias/envio', { body: { nome, tamanho: size, tipo: contentType } });
  if (res.status !== 200) return res;
  files.set(res.data.caminho, { size: realSize, contentType });
  return res;
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
    mediaStorage: storage,
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

describe('imagens e vídeos da página', () => {
  it('página pública começa sem mídias', async () => {
    const res = await call('GET', '/api/midias', { auth: false });
    assert.deepEqual(res.data, { topo: [], campanha: [], doacao: [], sobre: [], galeria: [] });
  });

  it('só administradores obtêm a URL de envio, para tipos e tamanhos aceitos', async () => {
    const anon = await call('POST', '/api/admin/midias/envio', {
      body: { nome: 'foto.jpg', tamanho: 1000, tipo: 'image/jpeg' },
      auth: false,
    });
    assert.equal(anon.status, 401);

    const res = await upload('Fotos do Abrigo (1).JPG', 'image/jpeg', 300_000);
    assert.equal(res.status, 200);
    assert.match(res.data.caminho, /^[a-z0-9]{12}-fotos-do-abrigo-1\.jpg$/);
    assert.match(res.data.uploadUrl, /\/object\/upload\/sign\/midias\//);

    for (const body of [
      { nome: 'virus.exe', tamanho: 10, tipo: 'application/x-msdownload' },
      { nome: 'gigante.png', tamanho: 16 * 1024 * 1024, tipo: 'image/png' },
      { nome: 'filme.mp4', tamanho: 51 * 1024 * 1024, tipo: 'video/mp4' },
      { nome: 'vazio.jpg', tamanho: 0, tipo: 'image/jpeg' },
    ]) {
      assert.equal((await call('POST', '/api/admin/midias/envio', { body })).status, 400, body.nome);
    }
  });

  let fotoId;
  let videoId;

  it('registra o arquivo enviado com tipo e tamanho lidos do próprio armazenamento', async () => {
    const foto = await upload('cachorros.jpg', 'image/jpeg', 300_000);
    const res = await call('POST', '/api/admin/midias', {
      body: { caminho: foto.data.caminho, local: 'topo', legenda: 'Nossos resgatados', alt: 'Cães no abrigo' },
    });
    assert.equal(res.status, 201);
    fotoId = res.data.id;
    assert.equal(res.data.tipo, 'imagem');
    assert.equal(res.data.url, `${SUPABASE}/storage/v1/object/public/midias/${foto.data.caminho}`);

    const vid = await upload('abrigo.mp4', 'video/mp4', 20_000_000);
    videoId = (await call('POST', '/api/admin/midias', { body: { caminho: vid.data.caminho, local: 'topo' } })).data.id;

    const pub = (await call('GET', '/api/midias', { auth: false })).data;
    assert.deepEqual(pub.topo.map((m) => [m.id, m.tipo, m.legenda]), [
      [fotoId, 'imagem', 'Nossos resgatados'],
      [videoId, 'video', null],
    ]);
  });

  it('recusa caminhos forjados, locais inválidos e arquivos fora das regras', async () => {
    for (const caminho of ['../segredo.jpg', 'outra-pasta/x.jpg', 'ABCDEFGHIJKL-x.jpg', 'https://site.com/x.jpg']) {
      assert.equal((await call('POST', '/api/admin/midias', { body: { caminho, local: 'topo' } })).status, 400, caminho);
    }
    const ok = await upload('a.jpg', 'image/jpeg', 10);
    assert.equal((await call('POST', '/api/admin/midias', { body: { caminho: ok.data.caminho, local: 'rodape' } })).status, 400);
    // O navegador declarou 1 MB mas enviou 16 MB: o servidor confere e apaga.
    const big = await upload('mentira.png', 'image/png', 1_000_000, 16 * 1024 * 1024);
    assert.equal((await call('POST', '/api/admin/midias', { body: { caminho: big.data.caminho, local: 'topo' } })).status, 400);
    assert.ok(deleted.includes(big.data.caminho));
    const missing = await call('POST', '/api/admin/midias/envio', { body: { nome: 'b.jpg', tamanho: 10, tipo: 'image/jpeg' } });
    assert.equal((await call('POST', '/api/admin/midias', { body: { caminho: missing.data.caminho, local: 'topo' } })).status, 400);
    assert.equal((await call('POST', '/api/admin/midias', { body: { caminho: 'x', local: 'topo' }, auth: false })).status, 401);
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
    assert.ok(deleted.some((path) => video.url.endsWith(path)));
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

describe('adaptador do Supabase Storage', () => {
  function fakeFetch(responses) {
    const calls = [];
    const fn = async (url, init) => {
      calls.push({ url: String(url), method: init.method, headers: init.headers, body: init.body });
      const next = responses.shift() ?? { status: 200, body: {} };
      return new Response(next.body === undefined ? null : JSON.stringify(next.body), {
        status: next.status,
        headers: next.headers,
      });
    };
    return { fn, calls };
  }

  it('cria o bucket público uma vez e pede a URL assinada com a chave secreta', async () => {
    const { fn, calls } = fakeFetch([
      { status: 200, body: { name: 'midias' } },
      { status: 200, body: { url: '/object/upload/sign/midias/abc-foto.jpg?token=XYZ' } },
      { status: 200, body: { url: '/object/upload/sign/midias/def-foto.jpg?token=W' } },
    ]);
    const st = createSupabaseStorage({ url: `${SUPABASE}/`, key: 'sb_secret_123', fetchImpl: fn });
    const first = await st.createUpload('abc-foto.jpg');
    await st.createUpload('def-foto.jpg');
    assert.equal(first.uploadUrl, `${SUPABASE}/storage/v1/object/upload/sign/midias/abc-foto.jpg?token=XYZ`);
    assert.equal(calls.length, 3); // bucket só na primeira vez
    assert.equal(calls[0].url, `${SUPABASE}/storage/v1/bucket`);
    assert.equal(JSON.parse(calls[0].body).public, true);
    assert.equal(calls[1].url, `${SUPABASE}/storage/v1/object/upload/sign/midias/abc-foto.jpg`);
    assert.equal(calls[1].headers.Authorization, 'Bearer sb_secret_123');
    assert.equal(calls[1].headers.apikey, 'sb_secret_123');
    assert.equal(st.publicUrl('abc-foto.jpg'), `${SUPABASE}/storage/v1/object/public/midias/abc-foto.jpg`);
  });

  it('aceita bucket já existente e lê tamanho/tipo pelo endereço público', async () => {
    const { fn, calls } = fakeFetch([
      { status: 400, body: { statusCode: '409', error: 'Duplicate', message: 'The resource already exists' } },
      { status: 200, body: { url: '/object/upload/sign/midias/x.png?token=1' } },
      { status: 200, headers: { 'content-length': '1234', 'content-type': 'image/png' } },
      { status: 200, body: [{ name: 'x.png' }] },
    ]);
    const st = createSupabaseStorage({ url: SUPABASE, key: 'k', fetchImpl: fn });
    await st.createUpload('x.png');
    assert.deepEqual(await st.head('x.png'), { size: 1234, contentType: 'image/png' });
    assert.equal(calls[2].method, 'HEAD');
    await st.del('x.png');
    assert.equal(calls[3].method, 'DELETE');
    assert.equal(calls[3].url, `${SUPABASE}/storage/v1/object/midias`);
    assert.deepEqual(JSON.parse(calls[3].body), { prefixes: ['x.png'] });
  });

  it('cria o bucket sem limite de tamanho se o projeto tiver limite global menor', async () => {
    const { fn, calls } = fakeFetch([
      { status: 400, body: { error: 'Payload too large', message: 'file size limit exceeds the global limit' } },
      { status: 200, body: { name: 'midias' } },
      { status: 200, body: { url: '/object/upload/sign/midias/y.jpg?token=1' } },
    ]);
    const st = createSupabaseStorage({ url: SUPABASE, key: 'k', fetchImpl: fn });
    await st.createUpload('y.jpg');
    assert.equal(JSON.parse(calls[1].body).file_size_limit, undefined);
  });
});
