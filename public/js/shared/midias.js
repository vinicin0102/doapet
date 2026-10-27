// Imagens e vídeos da página: locais disponíveis, tipos aceitos e limites.
// Usado pelo servidor (validação) e pelo painel (formulário), para não divergirem.

/** Locais da página inicial onde uma mídia pode aparecer (na ordem da página). */
export const MEDIA_SLOTS = {
  topo: 'Topo da página (abaixo do título)',
  campanha: 'Junto da barra da campanha',
  doacao: 'Junto do quadro de doações',
  sobre: 'Seção "Sobre nós"',
  galeria: 'Galeria (antes do rodapé)',
};

export const MEDIA_TYPES = {
  imagem: {
    extensions: ['jpg', 'jpeg', 'png', 'webp', 'gif'],
    contentTypes: ['image/jpeg', 'image/png', 'image/webp', 'image/gif'],
    maxBytes: 15 * 1024 * 1024,
  },
  video: {
    extensions: ['mp4', 'webm', 'mov'],
    contentTypes: ['video/mp4', 'video/webm', 'video/quicktime'],
    // 50 MB é o limite por arquivo do plano gratuito do Supabase.
    maxBytes: 50 * 1024 * 1024,
  },
};

/** Tipo da mídia ("imagem" | "video") pela extensão do arquivo, ou null se não aceito. */
export function mediaKindFromName(name) {
  const ext = String(name ?? '').toLowerCase().split('.').pop();
  for (const [kind, spec] of Object.entries(MEDIA_TYPES)) {
    if (spec.extensions.includes(ext)) return kind;
  }
  return null;
}

/** Tipo da mídia pelo content-type, ou null se não aceito. */
export function mediaKindFromContentType(contentType) {
  const type = String(contentType ?? '').split(';')[0].trim().toLowerCase();
  for (const [kind, spec] of Object.entries(MEDIA_TYPES)) {
    if (spec.contentTypes.includes(type)) return kind;
  }
  return null;
}
