// Armazenamento de arquivos no Supabase Storage (imagens e vídeos da página).
// O navegador do administrador envia o arquivo direto ao Supabase por uma URL
// assinada (válida por 2 horas) criada aqui; assim o arquivo não passa pela
// função da Vercel (limite de ~4,5 MB por requisição).
//
// A chave secreta (service role) fica só no servidor.

import { MEDIA_TYPES } from '../public/js/shared/midias.js';

const TIMEOUT_MS = 15_000;

export class StorageError extends Error {}

export function createSupabaseStorage({ url, key, bucket = 'midias', fetchImpl = fetch }) {
  const base = `${String(url).replace(/\/+$/, '')}/storage/v1`;
  const headers = { apikey: key, Authorization: `Bearer ${key}` };
  const encodePath = (path) => path.split('/').map(encodeURIComponent).join('/');
  let bucketReady = null;

  async function request(method, path, { body, extraHeaders } = {}) {
    let res;
    try {
      res = await fetchImpl(base + path, {
        method,
        headers: { ...headers, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...extraHeaders },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      throw new StorageError(`Supabase indisponível (${err.name}).`);
    }
    const text = await res.text();
    let data = {};
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      /* resposta sem JSON */
    }
    return { ok: res.ok, status: res.status, data };
  }

  /** Cria o bucket público (uma vez); se já existir, segue em frente. */
  function ensureBucket() {
    bucketReady ??= (async () => {
      const res = await request('POST', '/bucket', {
        body: {
          id: bucket,
          name: bucket,
          public: true,
          file_size_limit: Math.max(MEDIA_TYPES.imagem.maxBytes, MEDIA_TYPES.video.maxBytes),
          allowed_mime_types: [...MEDIA_TYPES.imagem.contentTypes, ...MEDIA_TYPES.video.contentTypes],
        },
      });
      let result = res;
      // Se o limite de tamanho passar do limite global do projeto, cria sem ele
      // (o servidor continua conferindo tipo e tamanho de cada arquivo).
      if (!res.ok && /size|limit/i.test(JSON.stringify(res.data)) && !/exist|duplicate/i.test(JSON.stringify(res.data))) {
        result = await request('POST', '/bucket', { body: { id: bucket, name: bucket, public: true } });
      }
      const exists = /exist|duplicate/i.test(JSON.stringify(result.data));
      if (!result.ok && !exists) {
        throw new StorageError(`Não foi possível preparar o bucket "${bucket}" no Supabase (HTTP ${result.status}).`);
      }
    })().catch((err) => {
      bucketReady = null;
      throw err;
    });
    return bucketReady;
  }

  return {
    bucket,
    publicUrl: (path) => `${base}/object/public/${bucket}/${encodePath(path)}`,

    /** URL assinada para o navegador enviar o arquivo com PUT. */
    async createUpload(path) {
      await ensureBucket();
      const res = await request('POST', `/object/upload/sign/${bucket}/${encodePath(path)}`, { body: {} });
      if (!res.ok || typeof res.data.url !== 'string') {
        throw new StorageError(`Supabase recusou a URL de envio (HTTP ${res.status}).`);
      }
      return { uploadUrl: base + res.data.url };
    },

    /** Tamanho e tipo reais do arquivo já enviado (lidos do próprio Supabase). */
    async head(path) {
      let res;
      try {
        res = await fetchImpl(`${base}/object/public/${bucket}/${encodePath(path)}`, {
          method: 'HEAD',
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
      } catch (err) {
        throw new StorageError(`Supabase indisponível (${err.name}).`);
      }
      if (!res.ok) throw new StorageError('Arquivo não encontrado.');
      return {
        size: Number(res.headers.get('content-length')),
        contentType: res.headers.get('content-type') ?? '',
      };
    },

    async del(path) {
      const res = await request('DELETE', `/object/${bucket}`, { body: { prefixes: [path] } });
      if (!res.ok) throw new StorageError(`Falha ao apagar o arquivo (HTTP ${res.status}).`);
    },
  };
}
