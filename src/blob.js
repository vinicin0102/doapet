// Armazenamento de arquivos no Vercel Blob (imagens e vídeos da página).
// O navegador do administrador envia o arquivo direto ao Blob com um token
// temporário gerado aqui; assim o arquivo não passa pela função (limite de ~4,5 MB).

import { del, head } from '@vercel/blob';
import { handleUpload } from '@vercel/blob/client';

/** O token tem o formato vercel_blob_rw_<storeId>_<segredo>. */
export function parseStoreId(token) {
  const match = /^vercel_blob_rw_([a-z0-9]+)_/i.exec(String(token ?? ''));
  return match ? match[1].toLowerCase() : null;
}

export function createBlobStorage(token) {
  const storeId = parseStoreId(token);
  if (!storeId) throw new Error('BLOB_READ_WRITE_TOKEN inválido.');
  return {
    /** Domínio público dos arquivos desta loja (usado para validar URLs recebidas). */
    publicHost: `${storeId}.public.blob.vercel-storage.com`,
    /** Responde ao pedido de token do upload() do navegador. */
    handleUploadRequest: (body, onBeforeGenerateToken) => handleUpload({ token, body, onBeforeGenerateToken }),
    /** Metadados autoritativos do arquivo (tamanho e tipo reais). */
    head: async (url) => {
      const info = await head(url, { token });
      return { size: info.size, contentType: info.contentType, pathname: info.pathname };
    },
    del: (url) => del(url, { token }),
  };
}
