import { MoneyError, parseBRL } from '/js/shared/money.js';
import { computeProgress, raisedForMode } from '/js/shared/progress.js';

const $ = (sel) => document.querySelector(sel);
const brl = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
const pct = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 1 });
const decimal = new Intl.NumberFormat('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const ACTION_LABELS = {
  configuracao_atualizada: 'Configuração atualizada',
  contribuicao_registrada: 'Contribuição externa registrada',
  contribuicao_removida: 'Contribuição externa removida',
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
  await loadState({ resetForm: true });
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

// ---------------------------------------------------------------- tempo real

let eventSource = null;
function subscribeUpdates() {
  if (eventSource || !('EventSource' in window)) return;
  let first = true;
  eventSource = new EventSource('/api/campanha/eventos');
  // Novos Pix ou alterações de outro administrador: atualiza totais e tabelas
  // sem apagar o que está sendo digitado no formulário.
  eventSource.addEventListener('progresso', () => {
    if (first) {
      first = false;
      return;
    }
    if (csrfToken) loadState().catch(() => {});
  });
}

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
