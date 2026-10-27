// Imagens e vídeos exibidos na página inicial, enviados pelo painel.

import crypto from 'node:crypto';
import { HttpError, addHistory, cleanText } from './campaign.js';
import {
  MEDIA_SLOTS,
  MEDIA_TYPES,
  mediaKindFromContentType,
  mediaKindFromName,
} from '../public/js/shared/midias.js';

const nowIso = () => new Date().toISOString();
const LOCK_ID = 777001; // trava consultiva: serializa alterações de ordem

function toPublic(row) {
  return {
    id: Number(row.id),
    tipo: row.kind,
    url: row.url,
    legenda: row.caption,
    alt: row.alt ?? row.caption ?? '',
  };
}

/** Mídias agrupadas por local, na ordem definida no painel. */
export async function listMediaBySlot(db) {
  const rows = await db.query('SELECT * FROM media ORDER BY position, id');
  const bySlot = Object.fromEntries(Object.keys(MEDIA_SLOTS).map((slot) => [slot, []]));
  for (const row of rows) bySlot[row.slot]?.push(toPublic(row));
  return bySlot;
}

/** Lista completa para o painel. */
export async function listMediaAdmin(db) {
  const rows = await db.query('SELECT * FROM media ORDER BY position, id');
  return rows.map((row) => ({
    ...toPublic(row),
    local: row.slot,
    tamanho: Number(row.size_bytes),
    enviadoEm: row.created_at,
    enviadoPor: row.created_by,
  }));
}

// Caminho gerado pelo servidor: "<12 caracteres aleatórios>-<nome>.<extensão>".
const PATH_RE = /^[a-z0-9]{12}-[a-z0-9-]{1,60}\.(jpg|jpeg|png|webp|gif|mp4|webm|mov)$/;

function safeBaseName(name) {
  const withoutExt = String(name).replace(/\.[^.]*$/, '');
  return (
    withoutExt
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'arquivo'
  );
}

/**
 * Prepara o envio de um arquivo: confere tipo e tamanho declarados, escolhe o
 * caminho no armazenamento e devolve a URL assinada para o navegador enviar.
 */
export async function prepareUpload(storage, input = {}) {
  const name = String(input.nome ?? '');
  const kind = mediaKindFromName(name);
  if (!kind) throw new HttpError(400, 'Tipo de arquivo não aceito. Use JPG, PNG, WEBP, GIF, MP4, WEBM ou MOV.');
  const size = Number(input.tamanho);
  if (!Number.isFinite(size) || size <= 0) throw new HttpError(400, 'Arquivo vazio ou inválido.');
  if (size > MEDIA_TYPES[kind].maxBytes) {
    throw new HttpError(400, `Arquivo muito grande. Limite: ${MEDIA_TYPES[kind].maxBytes / 1024 / 1024} MB.`);
  }
  const ext = name.toLowerCase().split('.').pop();
  const random = crypto.randomBytes(9).toString('base64url').toLowerCase().replace(/[^a-z0-9]/g, '0').slice(0, 12);
  const path = `${random}-${safeBaseName(name)}.${ext}`;
  const { uploadUrl } = await storage.createUpload(path);
  return { caminho: path, uploadUrl };
}

function validateSlot(slot) {
  if (!Object.hasOwn(MEDIA_SLOTS, slot)) throw new HttpError(400, 'Escolha onde a mídia vai aparecer.');
  return slot;
}

const texts = (input) => ({
  caption: cleanText(input.legenda, { field: 'Legenda', max: 200 }),
  alt: cleanText(input.alt, { field: 'Descrição da imagem', max: 200 }),
});

/** Registra um arquivo já enviado. Tipo e tamanho vêm do próprio armazenamento, não do navegador. */
export async function addMedia(db, storage, admin, input = {}) {
  const path = String(input.caminho ?? '');
  if (!PATH_RE.test(path)) throw new HttpError(400, 'O arquivo precisa ter sido enviado pelo painel.');
  const slot = validateSlot(input.local);
  const { caption, alt } = texts(input);

  let info;
  try {
    info = await storage.head(path);
  } catch {
    throw new HttpError(400, 'Arquivo não encontrado no armazenamento. Envie novamente.');
  }
  const kind = mediaKindFromContentType(info.contentType);
  if (!kind || !(info.size > 0) || info.size > MEDIA_TYPES[kind].maxBytes) {
    await storage.del(path).catch(() => {});
    throw new HttpError(400, 'Arquivo recusado: tipo não aceito ou tamanho acima do limite.');
  }
  const url = storage.publicUrl(path);

  return db.tx(async (t) => {
    await t.query('SELECT pg_advisory_xact_lock($1)', [LOCK_ID]);
    const { next } = await t.one('SELECT COALESCE(MAX(position), 0) + 1 AS next FROM media WHERE slot = $1', [slot]);
    const row = await t.one(
      `INSERT INTO media (url, pathname, kind, content_type, size_bytes, slot, position, caption, alt, created_at, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       ON CONFLICT (url) DO NOTHING RETURNING *`,
      [url, path, kind, info.contentType, info.size, slot, next, caption, alt, nowIso(), admin],
    );
    if (!row) throw new HttpError(409, 'Este arquivo já foi adicionado.');
    await addHistory(t, {
      admin,
      action: 'midia_adicionada',
      next: { tipo: kind === 'video' ? 'Vídeo' : 'Imagem', local: MEDIA_SLOTS[slot], legenda: caption, arquivo: path },
    });
    return toPublic(row);
  });
}

/** Altera local, legenda ou descrição. Trocar de local manda a mídia para o fim do novo local. */
export async function updateMedia(db, admin, id, input = {}) {
  const slot = validateSlot(input.local);
  const { caption, alt } = texts(input);
  return db.tx(async (t) => {
    await t.query('SELECT pg_advisory_xact_lock($1)', [LOCK_ID]);
    const row = await t.one('SELECT * FROM media WHERE id = $1', [id]);
    if (!row) throw new HttpError(404, 'Mídia não encontrada.');
    let position = row.position;
    if (slot !== row.slot) {
      position = (await t.one('SELECT COALESCE(MAX(position), 0) + 1 AS next FROM media WHERE slot = $1', [slot])).next;
    }
    await t.query('UPDATE media SET slot = $1, position = $2, caption = $3, alt = $4 WHERE id = $5', [
      slot,
      position,
      caption,
      alt,
      id,
    ]);
    await addHistory(t, {
      admin,
      action: 'midia_atualizada',
      previous: { local: MEDIA_SLOTS[row.slot], legenda: row.caption, arquivo: row.pathname },
      next: { local: MEDIA_SLOTS[slot], legenda: caption },
    });
  });
}

/** Sobe ou desce a mídia dentro do mesmo local. */
export async function moveMedia(db, id, direction) {
  if (direction !== 'cima' && direction !== 'baixo') throw new HttpError(400, 'Direção inválida.');
  return db.tx(async (t) => {
    await t.query('SELECT pg_advisory_xact_lock($1)', [LOCK_ID]);
    const row = await t.one('SELECT * FROM media WHERE id = $1', [id]);
    if (!row) throw new HttpError(404, 'Mídia não encontrada.');
    const neighbor = await t.one(
      direction === 'cima'
        ? 'SELECT * FROM media WHERE slot = $1 AND (position, id) < ($2, $3) ORDER BY position DESC, id DESC LIMIT 1'
        : 'SELECT * FROM media WHERE slot = $1 AND (position, id) > ($2, $3) ORDER BY position, id LIMIT 1',
      [row.slot, row.position, row.id],
    );
    if (!neighbor) return; // já está na ponta
    await t.query('UPDATE media SET position = $1 WHERE id = $2', [neighbor.position, row.id]);
    await t.query('UPDATE media SET position = $1 WHERE id = $2', [row.position, neighbor.id]);
  });
}

/** Remove da página e apaga o arquivo do armazenamento. */
export async function removeMedia(db, storage, admin, id) {
  const row = await db.tx(async (t) => {
    const found = await t.one('DELETE FROM media WHERE id = $1 RETURNING *', [id]);
    if (!found) throw new HttpError(404, 'Mídia não encontrada.');
    await addHistory(t, {
      admin,
      action: 'midia_removida',
      previous: {
        tipo: found.kind === 'video' ? 'Vídeo' : 'Imagem',
        local: MEDIA_SLOTS[found.slot],
        legenda: found.caption,
        arquivo: found.pathname,
      },
    });
    return found;
  });
  // Se apagar o arquivo falhar, ele só deixa de aparecer; o erro fica no log.
  await storage?.del(row.pathname).catch((err) => console.error(`Falha ao apagar ${row.pathname}: ${err.message}`));
}
