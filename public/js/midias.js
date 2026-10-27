// Exibe na página as imagens e vídeos enviados pelo painel, cada um no local escolhido.

function figure(item) {
  const fig = document.createElement('figure');
  fig.className = 'midia';
  let media;
  if (item.tipo === 'video') {
    media = document.createElement('video');
    media.controls = true;
    media.playsInline = true;
    media.preload = 'metadata';
    if (item.alt) media.setAttribute('aria-label', item.alt);
  } else {
    media = document.createElement('img');
    media.loading = 'lazy';
    media.decoding = 'async';
    media.alt = item.alt ?? '';
  }
  media.src = item.url;
  fig.appendChild(media);
  if (item.legenda) {
    const caption = document.createElement('figcaption');
    caption.textContent = item.legenda;
    fig.appendChild(caption);
  }
  return fig;
}

async function load() {
  let bySlot;
  try {
    const res = await fetch('/api/midias', { cache: 'no-store' });
    if (!res.ok) return;
    bySlot = await res.json();
  } catch {
    return;
  }
  for (const container of document.querySelectorAll('[data-midias]')) {
    const items = bySlot[container.dataset.midias] ?? [];
    container.replaceChildren(...items.map(figure));
    container.classList.toggle('midias--varias', items.length > 1);
    const section = container.closest('[data-secao-midias]');
    (section ?? container).hidden = items.length === 0;
  }
}

load();
