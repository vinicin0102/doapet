import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import * as auth from './auth.js';
import * as campaign from './campaign.js';
import { openDatabase } from './db.js';
import { DONATION_PRESETS, MOST_CHOSEN, validateDonor } from '../public/js/shared/doacao.js';
import { MoneyError } from '../public/js/shared/money.js';
import { PixConfigError, buildPixPayload, newTxid } from './brcode.js';
import { normalizePixPayload, verifySignature } from './pix.js';
import * as donations from './donations.js';
import * as media from './media.js';
import { createSupabaseStorage, StorageError } from './storage-supabase.js';
import { MEDIA_SLOTS } from '../public/js/shared/midias.js';
import { createZuckPayClient, extractWebhookIds, verifyZuckPaySignature, ZuckPayError } from './zuckpay.js';

const { HttpError } = campaign;
const MAX_BODY_BYTES = 64 * 1024;
const SESSION_COOKIE = 'doapet_admin';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
};

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'same-origin',
  // Imagens e vídeos vêm do Supabase Storage; o painel envia arquivos direto para lá.
  'Content-Security-Policy':
    "default-src 'self'; img-src 'self' data: https://*.supabase.co; media-src 'self' https://*.supabase.co; " +
    "style-src 'self'; script-src 'self'; connect-src 'self' https://*.supabase.co; " +
    "frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
};

function sendJson(res, status, data, headers = {}) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new HttpError(413, 'Requisição muito grande.'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function parseJson(raw) {
  if (raw.length === 0) return {};
  try {
    return JSON.parse(raw.toString('utf8'));
  } catch {
    throw new HttpError(400, 'JSON inválido.');
  }
}

async function readJson(req) {
  if (!String(req.headers['content-type'] ?? '').startsWith('application/json')) {
    throw new HttpError(415, 'Envie os dados como JSON.');
  }
  return parseJson(await readBody(req));
}

function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function createApp(config) {
  let db = null;
  let loginLimiter = null;
  let pixLimiter = null;
  const zuckpay = config.zuckpay ? createZuckPayClient({ ...config.zuckpay, fetchImpl: config.fetchImpl }) : null;
  // Dados fixos do pagador: sem eles (ou se inválidos) não é possível criar cobranças,
  // mas pagamentos já gerados continuam sendo confirmados.
  let zuckpayPayer = null;
  // Variáveis que faltam ou estão inválidas (só os nomes, nunca os valores), para diagnóstico.
  const zuckpayPending = [];
  if (config.zuckpay) {
    const { dados, erros } = validateDonor(config.zuckpay.payer, { emailOptional: true });
    for (const campo of Object.keys(erros ?? {})) zuckpayPending.push(`ZUCKPAY_PAGADOR_${campo.toUpperCase()}`);
    if (erros) console.error(`ZuckPay: dados do pagador inválidos (${zuckpayPending.join(', ')}).`);
    zuckpayPayer = dados ?? null;
  } else {
    zuckpayPending.push('ZUCKPAY_CLIENT_ID', 'ZUCKPAY_CLIENT_SECRET');
  }
  const canCreateZuckPay = Boolean(zuckpay && zuckpayPayer);

  // Armazenamento das imagens e vídeos (Supabase Storage). Sem ele, o envio fica indisponível.
  const storage =
    config.mediaStorage ?? (config.supabase ? createSupabaseStorage({ ...config.supabase, fetchImpl: config.fetchImpl }) : null);
  const requireStorage = () => {
    if (!storage) {
      throw new HttpError(503, 'O armazenamento de arquivos ainda não está configurado (Supabase).');
    }
    return storage;
  };
  let initPromise = null;

  // Inicialização preguiçosa: conecta ao banco e cria o esquema na primeira requisição
  // da API. Se falhar (ex.: banco fora do ar), tenta de novo na próxima.
  function ready() {
    initPromise ??= (async () => {
      if (config.onVercel && !config.databaseUrl) {
        throw new HttpError(503, 'Banco de dados não configurado (defina DATABASE_URL).');
      }
      const database = await openDatabase(config);
      await campaign.ensureCampaign(database, config.initialGoal);
      if (config.bootstrapAdmin && (await auth.countAdmins(database)) === 0) {
        await auth.createAdmin(database, config.bootstrapAdmin.username, config.bootstrapAdmin.password);
        console.log(`Administrador inicial "${config.bootstrapAdmin.username}" criado.`);
      }
      db = database;
      loginLimiter = new auth.RateLimiter(db);
      // Evita abuso na criação de cobranças: até 10 Pix gerados por IP a cada 10 minutos.
      pixLimiter = new auth.RateLimiter(db, { maxAttempts: 10, windowMs: 10 * 60_000 });
    })().catch((err) => {
      initPromise = null;
      throw err;
    });
    return initPromise;
  }

  const clientIp = (req) =>
    (config.trustProxy && String(req.headers['x-forwarded-for'] ?? '').split(',')[0].trim()) ||
    req.socket.remoteAddress;

  const sessionCookie = (value, maxAgeSeconds) =>
    `${SESSION_COOKIE}=${value}; Path=/api/admin; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSeconds}` +
    (config.secureCookies ? '; Secure' : '');

  /** Exige sessão válida; para métodos que alteram dados, exige também o token CSRF. */
  async function requireAdmin(req) {
    const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    const session = await auth.getSession(db, token);
    if (!session) throw new HttpError(401, 'Faça login como administrador.');
    if (req.method !== 'GET' && !auth.csrfMatches(session.csrfToken, req.headers['x-csrf-token'])) {
      throw new HttpError(403, 'Token de segurança inválido. Recarregue o painel.');
    }
    return session;
  }

  async function handleApi(req, res, url) {
    const route = `${req.method} ${url.pathname}`;

    // ---------- Diagnóstico: o que está configurado (só sim/não, nunca valores) ----------
    if (route === 'GET /api/status') {
      return sendJson(res, 200, {
        bancoDeDados: Boolean(config.databaseUrl),
        pagamentosZuckPay: canCreateZuckPay,
        armazenamentoDeMidias: Boolean(storage),
      });
    }

    // ---------- Quadro de doações ----------
    if (route === 'GET /api/doacoes/config') {
      return sendJson(res, 200, {
        // "zuckpay": cobrança pelo processador; "pix": Pix estático; null: indisponível.
        provedor: canCreateZuckPay ? 'zuckpay' : config.pixReceiver ? 'pix' : null,
        valores: DONATION_PRESETS,
        maisEscolhido: MOST_CHOSEN,
        ...(canCreateZuckPay ? {} : { pendenciasZuckPay: zuckpayPending }),
      });
    }

    if (route === 'POST /api/doacoes/pix') {
      const body = await readJson(req);
      const valor = Number(body.valor);
      if (!DONATION_PRESETS.includes(valor)) throw new HttpError(400, 'Escolha um dos valores disponíveis.');
      if (canCreateZuckPay) return createZuckPayDonation(req, res, valor);
      if (!config.pixReceiver) {
        throw new HttpError(503, 'As doações via Pix estão em configuração. Volte em breve!', {
          codigo: 'PIX_NAO_CONFIGURADO',
        });
      }
      let copiaECola;
      try {
        copiaECola = buildPixPayload({
          ...config.pixReceiver,
          amountCents: valor * 100,
          txid: newTxid(),
          description: 'Doacao racao',
        });
      } catch (err) {
        if (!(err instanceof PixConfigError)) throw err;
        console.error('Configuração Pix inválida:', err.message);
        throw new HttpError(503, 'As doações via Pix estão em configuração. Volte em breve!', {
          codigo: 'PIX_NAO_CONFIGURADO',
        });
      }
      return sendJson(res, 200, { valor, copiaECola });
    }

    // Demais rotas dependem do banco de dados.
    await ready();

    // ---------- Público (somente leitura) ----------
    if (route === 'GET /api/campanha') {
      return sendJson(res, 200, await campaign.getPublicSummary(db), { 'Access-Control-Allow-Origin': '*' });
    }

    // ---------- Status da doação (a página consulta até o pagamento ser confirmado) ----------
    if (route === 'GET /api/doacoes/status') {
      if (!zuckpay) throw new HttpError(404, 'Rota não encontrada.');
      return sendJson(res, 200, await donations.getDonationStatus(db, zuckpay, url.searchParams.get('id')));
    }

    // ---------- Postback da ZuckPay ----------
    // O corpo só identifica a cobrança; o status e o valor são sempre confirmados
    // na API da ZuckPay. Assim, um aviso falso não consegue inflar a arrecadação.
    if (route === 'POST /api/zuckpay/webhook') {
      if (!zuckpay) throw new HttpError(503, 'ZuckPay não configurada.');
      const raw = await readBody(req);
      if (
        config.zuckpay.webhookSecret &&
        !verifyZuckPaySignature(raw, req.headers['x-zuckpay-signature'], config.zuckpay.webhookSecret)
      ) {
        throw new HttpError(401, 'Assinatura inválida.');
      }
      const ids = extractWebhookIds(parseJson(raw));
      const txid = await donations.findDonationTxid(db, ids);
      // Vendas da conta que não são doações deste site: confirma o recebimento e ignora.
      if (!txid) return sendJson(res, 200, { ok: true, ignorado: true });
      const status = await donations.syncDonation(db, zuckpay, txid, { force: true });
      return sendJson(res, 200, { ok: true, status });
    }

    // ---------- Webhook do provedor Pix ----------
    if (route === 'POST /api/pix/webhook') {
      if (!config.pixWebhookSecret) throw new HttpError(503, 'Webhook Pix não configurado.');
      const raw = await readBody(req);
      if (!verifySignature(raw, req.headers['x-pix-signature'], config.pixWebhookSecret)) {
        throw new HttpError(401, 'Assinatura inválida.');
      }
      let events;
      try {
        events = normalizePixPayload(parseJson(raw));
      } catch (err) {
        if (err instanceof MoneyError) throw new HttpError(400, err.message);
        throw err;
      }
      for (const event of events) await campaign.recordPixEvent(db, event);
      return sendJson(res, 200, { ok: true, processados: events.length });
    }

    // ---------- Autenticação ----------
    if (route === 'POST /api/admin/login') {
      const ip = clientIp(req);
      if (await loginLimiter.isBlocked(`login:${ip}`)) {
        throw new HttpError(429, 'Muitas tentativas de login. Aguarde 15 minutos.');
      }
      const body = await readJson(req);
      const admin = await auth.authenticate(db, body.usuario, body.senha);
      if (!admin) {
        await loginLimiter.hit(`login:${ip}`);
        throw new HttpError(401, 'Usuário ou senha incorretos.');
      }
      await loginLimiter.reset(`login:${ip}`);
      const session = await auth.createSession(db, admin.id, config.sessionHours);
      return sendJson(
        res,
        200,
        { usuario: admin.username, csrfToken: session.csrfToken },
        { 'Set-Cookie': sessionCookie(session.token, config.sessionHours * 3600) },
      );
    }
    if (route === 'POST /api/admin/logout') {
      await requireAdmin(req);
      await auth.destroySession(db, parseCookies(req.headers.cookie)[SESSION_COOKIE]);
      return sendJson(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie('', 0) });
    }
    if (route === 'GET /api/admin/sessao') {
      const session = await requireAdmin(req);
      return sendJson(res, 200, { usuario: session.username, csrfToken: session.csrfToken });
    }

    // ---------- Gerenciar Meta da Campanha ----------
    if (route === 'GET /api/admin/campanha') {
      await requireAdmin(req);
      return sendJson(res, 200, await campaign.getAdminState(db));
    }
    if (route === 'PUT /api/admin/campanha') {
      const session = await requireAdmin(req);
      const result = await campaign.updateCampaign(db, session.username, await readJson(req));
      return sendJson(res, 200, { ...result, estado: await campaign.getAdminState(db) });
    }
    if (route === 'POST /api/admin/contribuicoes') {
      const session = await requireAdmin(req);
      const result = await campaign.addExternalContribution(db, session.username, await readJson(req));
      return sendJson(res, 201, { ...result, estado: await campaign.getAdminState(db) });
    }
    const removeMatch = /^\/api\/admin\/contribuicoes\/(\d+)$/.exec(url.pathname);
    if (req.method === 'DELETE' && removeMatch) {
      const session = await requireAdmin(req);
      await campaign.removeExternalContribution(db, session.username, Number(removeMatch[1]), await readJson(req));
      return sendJson(res, 200, { estado: await campaign.getAdminState(db) });
    }
    // ---------- Imagens e vídeos da página ----------
    if (route === 'GET /api/midias') {
      return sendJson(res, 200, await media.listMediaBySlot(db));
    }
    if (route === 'GET /api/admin/midias') {
      await requireAdmin(req);
      return sendJson(res, 200, {
        disponivel: Boolean(storage),
        locais: MEDIA_SLOTS,
        midias: await media.listMediaAdmin(db),
      });
    }
    if (route === 'POST /api/admin/midias/envio') {
      // Devolve a URL assinada para o navegador enviar o arquivo direto ao Supabase.
      await requireAdmin(req);
      const body = await readJson(req);
      try {
        return sendJson(res, 200, await media.prepareUpload(requireStorage(), body));
      } catch (err) {
        if (err instanceof StorageError) {
          console.error(err.message);
          throw new HttpError(502, 'O armazenamento de arquivos não respondeu. Tente novamente.');
        }
        throw err;
      }
    }
    if (route === 'POST /api/admin/midias') {
      const session = await requireAdmin(req);
      const item = await media.addMedia(db, requireStorage(), session.username, await readJson(req));
      return sendJson(res, 201, item);
    }
    const mediaMatch = /^\/api\/admin\/midias\/(\d+)(\/mover)?$/.exec(url.pathname);
    if (mediaMatch) {
      const session = await requireAdmin(req);
      const id = Number(mediaMatch[1]);
      if (mediaMatch[2] && req.method === 'POST') {
        await media.moveMedia(db, id, (await readJson(req)).direcao);
        return sendJson(res, 200, { ok: true });
      }
      if (!mediaMatch[2] && req.method === 'PUT') {
        await media.updateMedia(db, session.username, id, await readJson(req));
        return sendJson(res, 200, { ok: true });
      }
      if (!mediaMatch[2] && req.method === 'DELETE') {
        await media.removeMedia(db, storage, session.username, id);
        return sendJson(res, 200, { ok: true });
      }
    }

    if (route === 'GET /api/admin/historico') {
      await requireAdmin(req);
      return sendJson(res, 200, await campaign.listHistory(db, 500));
    }

    throw new HttpError(404, 'Rota não encontrada.');
  }

  async function createZuckPayDonation(req, res, valor) {
    await ready();
    const key = `pix:${clientIp(req)}`;
    if (await pixLimiter.isBlocked(key)) {
      throw new HttpError(429, 'Muitos Pix gerados em pouco tempo. Aguarde alguns minutos.');
    }
    await pixLimiter.hit(key);
    let charge;
    try {
      charge = await donations.createDonationCharge(db, zuckpay, {
        valor,
        doador: zuckpayPayer,
        urlnoty: config.siteUrl.startsWith('https://') ? `${config.siteUrl}/api/zuckpay/webhook` : undefined,
      });
    } catch (err) {
      if (err instanceof ZuckPayError) throw new HttpError(err.status, err.message);
      throw err;
    }
    return sendJson(res, 200, {
      valor,
      id: charge.id,
      copiaECola: charge.copiaECola,
    });
  }

  function serveStatic(req, res, url) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, SECURITY_HEADERS).end();
      return;
    }
    let pathname;
    try {
      pathname = decodeURIComponent(url.pathname);
    } catch {
      res.writeHead(400, SECURITY_HEADERS).end();
      return;
    }
    if (pathname.endsWith('/')) pathname += 'index.html';
    const file = path.resolve(config.publicDir, `.${pathname}`);
    if (!file.startsWith(config.publicDir + path.sep)) {
      res.writeHead(403, SECURITY_HEADERS).end();
      return;
    }
    fs.stat(file, (err, stat) => {
      if (err || !stat.isFile()) {
        // "/admin" sem barra final → redireciona para "/admin/".
        if (!err && stat.isDirectory()) {
          res.writeHead(301, { ...SECURITY_HEADERS, Location: `${url.pathname}/` }).end();
          return;
        }
        res.writeHead(404, { ...SECURITY_HEADERS, 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Página não encontrada.');
        return;
      }
      const ext = path.extname(file);
      const headers = {
        ...SECURITY_HEADERS,
        'Content-Type': MIME[ext] ?? 'application/octet-stream',
        'Content-Length': stat.size,
        // HTML/JS/CSS sempre revalidados: mudanças aparecem sem limpar cache.
        'Cache-Control': 'no-cache',
      };
      // O script do widget pode ser incorporado em outro site da ONG.
      if (pathname === '/js/barra-meta.js') headers['Access-Control-Allow-Origin'] = '*';
      res.writeHead(200, headers);
      if (req.method === 'HEAD') res.end();
      else fs.createReadStream(file).pipe(res);
    });
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    try {
      if (url.pathname.startsWith('/api/')) await handleApi(req, res, url);
      else serveStatic(req, res, url);
    } catch (err) {
      if (err instanceof HttpError) {
        sendJson(res, err.status, { erro: err.message, ...err.extra });
      } else {
        console.error(err);
        sendJson(res, 500, { erro: 'Erro interno. Tente novamente.' });
      }
    }
  });

  server.on('close', () => {
    db?.close();
  });

  return { server, ready };
}
