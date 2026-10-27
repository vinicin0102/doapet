// Imagens e vídeos exibidos na página inicial, enviados pelo painel.

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

/**
 * Regras do token de upload: só a pasta "midias/", só os tipos aceitos e o
 * tamanho máximo do tipo (imagem 15 MB, vídeo 200 MB), definidos pela extensão.
 */
export function uploadTokenOptions(pathname) {
  if (!/^midias\/[A-Za-z0-9._-]{1,120}$/.test(String(pathname))) {
    throw new HttpError(400, 'Nome de arquivo inválido.');
  }
  const kind = mediaKindFromName(pathname);
  if (!kind) throw new HttpError(400, 'Tipo de arquivo não aceito. Use JPG, PNG, WEBP, GIF, MP4, WEBM ou MOV.');
  return {
    allowedContentTypes: MEDIA_TYPES[kind].contentTypes,
    maximumSizeInBytes: MEDIA_TYPES[kind].maxBytes,
    addRandomSuffix: true,
    validUntil: Date.now() + 30 * 60_000,
  };
}

function validateSlot(slot) {
  if (!Object.hasOwn(MEDIA_SLOTS, slot)) throw new HttpError(400, 'Escolha onde a mídia vai aparecer.');
  return slot;
}

const texts = (input) => ({
  caption: cleanText(input.legenda, { field: 'Legenda', max: 200 }),
  alt: cleanText(input.alt, { field: 'Descrição da imagem', max: 200 }),
});

/** Registra um arquivo já enviado ao Blob. Tipo e tamanho vêm do próprio Blob, não do navegador. */
export async function addMedia(db, storage, admin, input = {}) {
  let url;
  try {
    url = new URL(String(input.url));
  } catch {
    throw new HttpError(400, 'Endereço do arquivo inválido.');
  }
  if (url.protocol !== 'https:' || url.host !== storage.publicHost || !url.pathname.startsWith('/midias/')) {
    throw new HttpError(400, 'O arquivo precisa ter sido enviado pelo painel.');
  }
  const slot = validateSlot(input.local);
  const { caption, alt } = texts(input);

  let info;
  try {
    info = await storage.head(url.href);
  } catch {
    throw new HttpError(400, 'Arquivo não encontrado no armazenamento. Envie novamente.');
  }
  const kind = mediaKindFromContentType(info.contentType);
  if (!kind || info.size > MEDIA_TYPES[kind].maxBytes) {
    await storage.del(url.href).catch(() => {});
    throw new HttpError(400, 'Arquivo recusado: tipo não aceito ou tamanho acima do limite.');
  }

  return db.tx(async (t) => {
    await t.query('SELECT pg_advisory_xact_lock($1)', [LOCK_ID]);
    const { next } = await t.one('SELECT COALESCE(MAX(position), 0) + 1 AS next FROM media WHERE slot = $1', [slot]);
    const row = await t.one(
      `INSERT INTO media (url, pathname, kind, content_type, size_bytes, slot, position, caption, alt, created_at, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       ON CONFLICT (url) DO NOTHING RETURNING *`,
      [url.href, info.pathname, kind, info.contentType, info.size, slot, next, caption, alt, nowIso(), admin],
    );
    if (!row) throw new HttpError(409, 'Este arquivo já foi adicionado.');
    await addHistory(t, {
      admin,
      action: 'midia_adicionada',
      next: { tipo: kind === 'video' ? 'Vídeo' : 'Imagem', local: MEDIA_SLOTS[slot], legenda: caption, arquivo: info.pathname },
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
  await storage?.del(row.url).catch((err) => console.error(`Blob: falha ao apagar ${row.pathname}: ${err.message}`));
}
