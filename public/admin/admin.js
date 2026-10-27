import { MoneyError, parseBRL } from '../js/shared/money.js';
import { computeProgress, raisedForMode } from '../js/shared/progress.js';
import { MEDIA_TYPES, mediaKindFromName } from '../js/shared/midias.js';

const $ = (sel) => document.querySelector(sel);
const brl = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
const pct = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 1 });
const decimal = new Intl.NumberFormat('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const ACTION_LABELS = {
  configuracao_atualizada: 'Configuração atualizada',
  contribuicao_registrada: 'Contribuição externa registrada',
  contribuicao_removida: 'Contribuição externa removida',
  midia_adicionada: 'Imagem/vídeo adicionado',
  midia_atualizada: 'Imagem/vídeo alterado',
  midia_removida: 'Imagem/vídeo removido',
};
const FIELD_LABELS = {
  meta: 'Meta',
  modo: 'Modo',
  valorManual: 'Valor manual',
  origemManual: 'Origem do valor',
  arrecadadoExibido: 'Arrecadado exibido',
  contribuicao: 'Contribuição nº',
  valor: 'Valor',
  origem: 'Origem',
  referencia: 'Referência',
  dataRecebimento: 'Recebido em',
  contribuicoesExternas: 'Total de contribuições externas',
  tipo: 'Tipo',
  local: 'Local',
  legenda: 'Legenda',
  arquivo: 'Arquivo',
};
const STATUS_LABELS = { pendente: 'Pendente', confirmada: 'Confirmada', devolvida: 'Devolvida' };

let csrfToken = null;
let state = null;
// Versão dos dados carregados no formulário (detecta edição simultânea de outro administrador).
let formVersion = null;
// Último valor manual digitado, preservado ao alternar entre os modos.
let manualDraft = '';

const formCampanha = $('#form-campanha');
const formContribuicao = $('#form-contribuicao');

// ---------------------------------------------------------------- utilidades

class ApiError extends Error {
  constructor(status, data) {
    super(data?.erro || `Erro ${status}`);
    this.status = status;
    this.data = data ?? {};
  }
}

async function api(method, url, body) {
  const headers = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (method !== 'GET' && csrfToken) headers['X-CSRF-Token'] = csrfToken;
  const res = await fetch(url, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    credentials: 'same-origin',
    cache: 'no-store',
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && url !== '/api/admin/login') showLogin();
  if (!res.ok) throw new ApiError(res.status, data);
  return data;
}

function setMessage(el, text, type) {
  el.textContent = text;
  el.className = `mensagem${type ? ` mensagem--${type}` : ''}`;
}

const formatDateTime = (iso) => (iso ? new Date(iso).toLocaleString('pt-BR') : '—');
const formatDate = (ymd) => (ymd ? ymd.split('-').reverse().join('/') : '—');
const toInputMoney = (reais) => decimal.format(reais);

function todayLocal() {
  const d = new Date();
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 10);
}

function cell(text, className) {
  const td = document.createElement('td');
  if (className) td.className = className;
  td.textContent = text ?? '—';
  return td;
}

function emptyRow(tbody, cols, text) {
  const tr = document.createElement('tr');
  const td = cell(text, 'vazio');
  td.colSpan = cols;
  tr.appendChild(td);
  tbody.replaceChildren(tr);
}

// ---------------------------------------------------------------- sessão

function showLogin() {
  csrfToken = null;
  $('#tela-painel').hidden = true;
  $('#area-usuario').hidden = true;
  $('#tela-login').hidden = false;
  $('#form-login [name=usuario]').focus();
}

async function showPanel(usuario) {
  $('#tela-login').hidden = true;
  $('#nome-usuario').textContent = `Olá, ${usuario}`;
  $('#area-usuario').hidden = false;
  await Promise.all([loadState({ resetForm: true }), loadMedia()]);
  $('#tela-painel').hidden = false;
  subscribeUpdates();
}

$('#form-login').addEventListener('submit', async (e) => {
  e.preventDefault();
  const msg = $('#mensagem-login');
  const form = e.currentTarget;
  setMessage(msg, '');
  try {
    const data = await api('POST', '/api/admin/login', {
      usuario: form.usuario.value,
      senha: form.senha.value,
    });
    form.senha.value = '';
    csrfToken = data.csrfToken;
    await showPanel(data.usuario);
  } catch (err) {
    setMessage(msg, err.message, 'erro');
  }
});

$('#botao-sair').addEventListener('click', async () => {
  try {
    await api('POST', '/api/admin/logout');
  } finally {
    showLogin();
  }
});

// ---------------------------------------------------------------- estado

async function loadState({ resetForm = false } = {}) {
  applyState(await api('GET', '/api/admin/campanha'), { resetForm });
}

function applyState(newState, { resetForm = false } = {}) {
  state = newState;
  if (resetForm) {
    formCampanha.meta.value = toInputMoney(state.meta);
    formCampanha.querySelector(`[name=modo][value=${state.modo}]`).checked = true;
    manualDraft = toInputMoney(state.valorManual);
    formCampanha.valorManual.disabled = false;
    formCampanha.valorManual.value = manualDraft;
    formVersion = state.versao;
    formCampanha.origemManual.value = state.origemManual ?? '';
    formCampanha.observacao.value = '';
  }
  $('#ultima-atualizacao').textContent =
    `Última alteração: ${formatDateTime(state.atualizadoEm)}` +
    (state.atualizadoPor ? ` por ${state.atualizadoPor}` : '');
  renderContributions();
  renderPix();
  renderHistory();
  updateModeUi();
}

function currentMode() {
  return formCampanha.querySelector('[name=modo]:checked')?.value ?? state.modo;
}

/** Ativa/desativa campos conforme o modo e explica de onde vem o valor. */
function updateModeUi() {
  const mode = currentMode();
  const input = formCampanha.valorManual;
  const t = state.totais;
  const isManual = mode === 'manual';

  if (isManual) {
    if (input.disabled) input.value = manualDraft;
  } else {
    if (!input.disabled) manualDraft = input.value;
    const auto = mode === 'automatico' ? t.pixConfirmado : t.pixConfirmado + t.contribuicoesExternas;
    input.value = toInputMoney(auto);
  }
  input.disabled = !isManual;
  formCampanha.origemManual.disabled = !isManual;
  $('#campo-origem').hidden = !isManual;

  const help = $('#ajuda-manual');
  const aviso = $('#bloco-automatico');
  if (mode === 'automatico') {
    help.textContent = 'Bloqueado: no modo automático o valor vem somente das doações Pix confirmadas.';
    aviso.textContent =
      `Valor calculado automaticamente: ${brl.format(t.pixConfirmado)} ` +
      `em ${t.quantidadePix} doação(ões) Pix confirmada(s).`;
  } else if (mode === 'hibrido') {
    help.textContent = 'Bloqueado: no modo híbrido registre as contribuições externas na lista abaixo.';
    aviso.textContent =
      `Pix confirmados (${brl.format(t.pixConfirmado)}) + contribuições externas registradas ` +
      `(${brl.format(t.contribuicoesExternas)}) = ${brl.format(t.pixConfirmado + t.contribuicoesExternas)}.`;
  } else {
    help.textContent =
      'Informe o total arrecadado por todos os meios (somente valores reais e registrados).';
    aviso.textContent =
      t.pixConfirmado > 0
        ? `Atenção: no modo manual a barra mostra apenas o valor informado acima. ` +
          `Os ${brl.format(t.pixConfirmado)} em Pix confirmados não são somados automaticamente — ` +
          `inclua-os no total se for o caso.`
        : '';
  }
  updatePreview();
}

/** Recalcula a pré-visualização com as mesmas regras usadas pelo servidor. */
function updatePreview() {
  const t = state.totais;
  const mode = currentMode();
  const msg = $('#mensagem-campanha');
  let goalCents;
  let manualCents;
  try {
    goalCents = parseBRL(formCampanha.meta.value, { allowZero: false });
    manualCents = mode === 'manual' ? parseBRL(formCampanha.valorManual.value) : Math.round(state.valorManual * 100);
  } catch (err) {
    if (!(err instanceof MoneyError)) throw err;
    setMessage(msg, err.message, 'erro');
    $('#botao-salvar').disabled = true;
    return;
  }
  if (msg.classList.contains('mensagem--erro')) setMessage(msg, '');
  $('#botao-salvar').disabled = false;

  const raised = raisedForMode(mode, {
    pixCents: Math.round(t.pixConfirmado * 100),
    externalCents: Math.round(t.contribuicoesExternas * 100),
    manualCents,
  });
  const p = computeProgress(goalCents, raised);
  window.BarraMeta.render($('#previa-barra'), {
    meta: p.goalCents / 100,
    arrecadado: p.raisedCents / 100,
    falta: p.remainingCents / 100,
    percentual: p.percent,
    percentualBarra: p.barPercent,
    metaAtingida: p.goalReached,
  });
  $('#resumo-arrecadado').textContent = brl.format(p.raisedCents / 100);
  $('#resumo-percentual').textContent = `${pct.format(p.percent)}%`;
  $('#resumo-falta').textContent = brl.format(p.remainingCents / 100);
  $('#resumo-pix').textContent = `${brl.format(t.pixConfirmado)} (${t.quantidadePix})`;
  $('#resumo-externas').textContent = `${brl.format(t.contribuicoesExternas)} (${t.quantidadeContribuicoes})`;
}

formCampanha.addEventListener('input', (e) => {
  if (e.target.name === 'modo') updateModeUi();
  else updatePreview();
});

formCampanha.addEventListener('submit', async (e) => {
  e.preventDefault();
  const msg = $('#mensagem-campanha');
  const button = $('#botao-salvar');
  const mode = currentMode();
  const payload = {
    versao: formVersion,
    meta: formCampanha.meta.value,
    modo: mode,
    observacao: formCampanha.observacao.value,
  };
  if (mode === 'manual') {
    payload.valorManual = formCampanha.valorManual.value;
    payload.origemManual = formCampanha.origemManual.value;
    if (!payload.origemManual.trim()) {
      setMessage(msg, 'Informe a origem do valor arrecadado.', 'erro');
      formCampanha.origemManual.focus();
      return;
    }
  }

  button.disabled = true;
  setMessage(msg, 'Salvando…');
  try {
    let result;
    try {
      result = await api('PUT', '/api/admin/campanha', payload);
    } catch (err) {
      if (err.data.codigo !== 'CONFIRMACAO_NECESSARIA' || !window.confirm(err.message)) throw err;
      result = await api('PUT', '/api/admin/campanha', { ...payload, confirmarModoManual: true });
    }
    applyState(result.estado, { resetForm: true });
    if (result.alterado) notifyPublicPage();
    setMessage(
      msg,
      result.alterado
        ? 'Alterações salvas! A barra pública já foi atualizada.'
        : 'Nenhuma alteração para salvar.',
      'ok',
    );
  } catch (err) {
    setMessage(msg, err.message, 'erro');
    if (err.data?.codigo === 'VERSAO_DESATUALIZADA') await loadState({ resetForm: true });
  } finally {
    button.disabled = false;
  }
});

// ---------------------------------------------------------------- contribuições externas

function renderContributions() {
  const select = formContribuicao.origem;
  if (select.options.length === 0) {
    for (const [value, label] of Object.entries(state.origensExternas)) {
      select.add(new Option(label, value));
    }
  }
  if (!formContribuicao.dataRecebimento.value) formContribuicao.dataRecebimento.value = todayLocal();
  formContribuicao.dataRecebimento.max = todayLocal();

  const tbody = $('#tabela-contribuicoes');
  if (state.contribuicoes.length === 0) {
    emptyRow(tbody, 6, 'Nenhuma contribuição externa registrada.');
    return;
  }
  tbody.replaceChildren(
    ...state.contribuicoes.map((c) => {
      const tr = document.createElement('tr');
      tr.append(
        cell(formatDate(c.dataRecebimento)),
        cell(brl.format(c.valor)),
        cell(c.observacao ? `${c.origemDescricao} — ${c.observacao}` : c.origemDescricao),
        cell(c.referencia),
        cell(`${c.registradoPor} em ${formatDateTime(c.registradoEm)}`),
      );
      const actions = document.createElement('td');
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'botao-link';
      remove.textContent = 'Remover';
      remove.addEventListener('click', () => removeContribution(c));
      actions.appendChild(remove);
      tr.appendChild(actions);
      return tr;
    }),
  );
}

formContribuicao.addEventListener('submit', async (e) => {
  e.preventDefault();
  const msg = $('#mensagem-contribuicao');
  const f = formContribuicao;
  try {
    const result = await api('POST', '/api/admin/contribuicoes', {
      valor: f.valor.value,
      origem: f.origem.value,
      dataRecebimento: f.dataRecebimento.value,
      referencia: f.referencia.value,
      observacao: f.observacao.value,
    });
    f.valor.value = '';
    f.referencia.value = '';
    f.observacao.value = '';
    applyState(result.estado);
    notifyPublicPage();
    setMessage(
      msg,
      state.modo === 'hibrido'
        ? 'Contribuição registrada e somada à barra pública.'
        : 'Contribuição registrada. Ela será somada à barra pública no modo híbrido.',
      'ok',
    );
  } catch (err) {
    setMessage(msg, err.message, 'erro');
  }
});

async function removeContribution(c) {
  const msg = $('#mensagem-contribuicao');
  const motivo = window.prompt(
    `Remover a contribuição de ${brl.format(c.valor)} (${c.origemDescricao})?\n` +
      'Informe o motivo (fica registrado no histórico):',
  );
  if (motivo === null) return;
  try {
    const result = await api('DELETE', `/api/admin/contribuicoes/${c.id}`, { motivo });
    applyState(result.estado);
    notifyPublicPage();
    setMessage(msg, 'Contribuição removida.', 'ok');
  } catch (err) {
    setMessage(msg, err.message, 'erro');
  }
}

// ---------------------------------------------------------------- Pix e histórico

function renderPix() {
  const tbody = $('#tabela-pix');
  if (state.pixRecentes.length === 0) {
    emptyRow(tbody, 4, 'Nenhuma doação Pix recebida do provedor até agora.');
    return;
  }
  tbody.replaceChildren(
    ...state.pixRecentes.map((p) => {
      const tr = document.createElement('tr');
      const status = document.createElement('td');
      const badge = document.createElement('span');
      badge.className = `status status--${p.status}`;
      badge.textContent = STATUS_LABELS[p.status] ?? p.status;
      status.appendChild(badge);
      const valor = p.devolvido > 0 ? `${brl.format(p.valor)} (devolvido ${brl.format(p.devolvido)})` : brl.format(p.valor);
      tr.append(cell(formatDateTime(p.pagoEm ?? p.recebidoEm)), cell(valor), status, cell(p.txid));
      return tr;
    }),
  );
}

function valuesCell(values) {
  const td = document.createElement('td');
  if (!values) {
    td.textContent = '—';
    return td;
  }
  const ul = document.createElement('ul');
  ul.className = 'valores';
  for (const [key, value] of Object.entries(values)) {
    if (value === null || value === undefined || value === '') continue;
    const li = document.createElement('li');
    const shown = key === 'modo' ? (state.modos[value] ?? value) : key === 'dataRecebimento' ? formatDate(value) : value;
    li.textContent = `${FIELD_LABELS[key] ?? key}: ${shown}`;
    ul.appendChild(li);
  }
  td.appendChild(ul);
  return td;
}

function renderHistory() {
  const tbody = $('#tabela-historico');
  if (state.historico.length === 0) {
    emptyRow(tbody, 6, 'Nenhuma alteração registrada ainda.');
    return;
  }
  tbody.replaceChildren(
    ...state.historico.map((h) => {
      const tr = document.createElement('tr');
      tr.append(
        cell(formatDateTime(h.data)),
        cell(h.administrador),
        cell(ACTION_LABELS[h.acao] ?? h.acao),
        valuesCell(h.valoresAnteriores),
        valuesCell(h.valoresNovos),
        cell(h.observacao),
      );
      return tr;
    }),
  );
}

// ---------------------------------------------------------------- atualização

// Avisa a página pública aberta neste navegador para recarregar a barra na hora.
const channel = 'BroadcastChannel' in window ? new BroadcastChannel('doapet-campanha') : null;
const notifyPublicPage = () => channel?.postMessage('atualizado');

let refreshTimer = null;
function subscribeUpdates() {
  if (refreshTimer) return;
  // Novos Pix ou alterações de outro administrador: atualiza totais e tabelas
  // sem apagar o que está sendo digitado no formulário.
  refreshTimer = setInterval(() => {
    if (csrfToken && document.visibilityState === 'visible') loadState().catch(() => {});
  }, 30000);
}

// ---------------------------------------------------------------- imagens e vídeos

const formMidia = $('#form-midia');
let mediaSlots = {};

const formatSize = (bytes) =>
  bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1).replace('.', ',')} MB` : `${Math.ceil(bytes / 1024)} KB`;

function slotSelect(name, selected) {
  const select = document.createElement('select');
  select.name = name;
  for (const [value, label] of Object.entries(mediaSlots)) select.add(new Option(label, value, false, value === selected));
  return select;
}

function labeled(text, input) {
  const label = document.createElement('label');
  label.className = 'campo';
  const span = document.createElement('span');
  span.textContent = text;
  label.append(span, input);
  return label;
}

function smallButton(text, onClick, { danger = false, disabled = false } = {}) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = `botao-pequeno${danger ? ' botao-pequeno--perigo' : ''}`;
  b.textContent = text;
  b.disabled = disabled;
  b.addEventListener('click', onClick);
  return b;
}

async function mediaAction(fn, successText) {
  const msg = $('#mensagem-midia');
  try {
    await fn();
    setMessage(msg, successText, 'ok');
    await Promise.all([loadMedia(), loadState()]);
  } catch (err) {
    setMessage(msg, err.message, 'erro');
  }
}

function mediaItem(item, index, total) {
  const box = document.createElement('div');
  box.className = 'midia-item';

  const preview = document.createElement(item.tipo === 'video' ? 'video' : 'img');
  preview.className = 'midia-item__previa';
  preview.src = item.url;
  if (item.tipo === 'video') {
    preview.muted = true;
    preview.preload = 'metadata';
    preview.controls = true;
  } else {
    preview.alt = item.alt;
    preview.loading = 'lazy';
  }

  const fields = document.createElement('div');
  fields.className = 'midia-item__campos';
  const legenda = Object.assign(document.createElement('input'), { maxLength: 200, value: item.legenda ?? '' });
  const alt = Object.assign(document.createElement('input'), { maxLength: 200, value: item.alt ?? '' });
  const local = slotSelect('local', item.local);
  const info = document.createElement('p');
  info.className = 'midia-item__info';
  info.textContent = `${item.tipo === 'video' ? 'Vídeo' : 'Imagem'} · ${formatSize(item.tamanho)} · enviado por ${item.enviadoPor} em ${formatDateTime(item.enviadoEm)}`;

  const actions = document.createElement('div');
  actions.className = 'midia-item__acoes';
  actions.append(
    smallButton('Salvar', () =>
      mediaAction(
        () => api('PUT', `/api/admin/midias/${item.id}`, { local: local.value, legenda: legenda.value, alt: alt.value }),
        'Alterações salvas. A página já foi atualizada.',
      ),
    ),
    smallButton('↑ Subir', () => mediaAction(() => api('POST', `/api/admin/midias/${item.id}/mover`, { direcao: 'cima' }), 'Ordem alterada.'), {
      disabled: index === 0,
    }),
    smallButton('↓ Descer', () => mediaAction(() => api('POST', `/api/admin/midias/${item.id}/mover`, { direcao: 'baixo' }), 'Ordem alterada.'), {
      disabled: index === total - 1,
    }),
    smallButton(
      'Remover',
      () => {
        if (!window.confirm('Remover esta mídia da página? O arquivo será apagado.')) return;
        mediaAction(() => api('DELETE', `/api/admin/midias/${item.id}`), 'Mídia removida.');
      },
      { danger: true },
    ),
  );

  fields.append(labeled('Onde aparece', local), labeled('Legenda', legenda), labeled('Descrição', alt), info, actions);
  box.append(preview, fields);
  return box;
}

async function loadMedia() {
  const data = await api('GET', '/api/admin/midias');
  mediaSlots = data.locais;
  $('#aviso-midias').hidden = data.disponivel;
  $('#botao-enviar-midia').disabled = !data.disponivel;
  const select = formMidia.local;
  if (select.options.length === 0) {
    for (const [value, label] of Object.entries(mediaSlots)) select.add(new Option(label, value));
  }

  const list = $('#lista-midias');
  const groups = Object.entries(mediaSlots).map(([slot, label]) => {
    const items = data.midias.filter((m) => m.local === slot);
    if (items.length === 0) return null;
    const group = document.createElement('div');
    const title = document.createElement('h3');
    title.textContent = `${label} (${items.length})`;
    group.append(title, ...items.map((item, i) => mediaItem(item, i, items.length)));
    return group;
  });
  const filled = groups.filter(Boolean);
  if (filled.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'lista-midias__vazia';
    empty.textContent = 'Nenhuma imagem ou vídeo enviado ainda.';
    list.replaceChildren(empty);
  } else {
    list.replaceChildren(...filled);
  }
}

/** Envia o arquivo direto ao armazenamento (URL assinada), informando o progresso. */
function putFile(url, file, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url);
    xhr.setRequestHeader('Content-Type', file.type || 'application/octet-stream');
    xhr.setRequestHeader('x-upsert', 'false');
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress((e.loaded / e.total) * 100);
    xhr.onload = () =>
      xhr.status >= 200 && xhr.status < 300
        ? resolve()
        : reject(new Error(`O armazenamento recusou o arquivo (HTTP ${xhr.status}).`));
    xhr.onerror = () => reject(new Error('Falha de conexão durante o envio. Tente novamente.'));
    xhr.send(file);
  });
}

formMidia.addEventListener('submit', async (e) => {
  e.preventDefault();
  const msg = $('#mensagem-midia');
  const progress = $('#progresso-midia');
  const button = $('#botao-enviar-midia');
  const file = formMidia.arquivo.files[0];
  if (!file) {
    setMessage(msg, 'Escolha um arquivo.', 'erro');
    return;
  }
  const kind = mediaKindFromName(file.name);
  if (!kind) {
    setMessage(msg, 'Tipo de arquivo não aceito. Use JPG, PNG, WEBP, GIF, MP4, WEBM ou MOV.', 'erro');
    return;
  }
  if (file.size > MEDIA_TYPES[kind].maxBytes) {
    setMessage(msg, `Arquivo muito grande. Limite: ${formatSize(MEDIA_TYPES[kind].maxBytes)}.`, 'erro');
    return;
  }

  button.disabled = true;
  progress.hidden = false;
  progress.value = 0;
  setMessage(msg, 'Enviando…');
  try {
    // 1) o servidor confere o arquivo e devolve uma URL assinada;
    // 2) o navegador envia o arquivo direto ao armazenamento;
    // 3) o servidor confere o arquivo recebido e o coloca na página.
    const { caminho, uploadUrl } = await api('POST', '/api/admin/midias/envio', {
      nome: file.name,
      tamanho: file.size,
      tipo: file.type,
    });
    await putFile(uploadUrl, file, (pct) => {
      progress.value = pct;
    });
    await api('POST', '/api/admin/midias', {
      caminho,
      local: formMidia.local.value,
      legenda: formMidia.legenda.value,
      alt: formMidia.alt.value,
    });
    formMidia.reset();
    setMessage(msg, 'Enviado! A mídia já aparece na página.', 'ok');
    await Promise.all([loadMedia(), loadState()]);
  } catch (err) {
    setMessage(msg, err.message || 'Falha no envio. Tente novamente.', 'erro');
  } finally {
    button.disabled = false;
    progress.hidden = true;
  }
});

// ---------------------------------------------------------------- início

api('GET', '/api/admin/sessao')
  .then((data) => {
    csrfToken = data.csrfToken;
    return showPanel(data.usuario);
  })
  .catch((err) => {
    if (err.status !== 401) console.error(err);
    showLogin();
  });
