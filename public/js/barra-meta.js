/*
 * Barra de progresso da campanha (widget público).
 *
 * Uso em qualquer página:
 *   <link rel="stylesheet" href="https://SEU-SITE/css/barra-meta.css">
 *   <div data-meta-campanha></div>
 *   <script src="https://SEU-SITE/js/barra-meta.js" defer></script>
 *
 * Os valores vêm da API (/api/campanha) e são atualizados em tempo real
 * (Server-Sent Events) sempre que o administrador salva ou um Pix é confirmado.
 */
(function () {
  'use strict';

  var brl = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
  var pct = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 1 });

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  /** Desenha a barra dentro de `container` a partir dos dados da API. */
  function render(container, data) {
    var meta = Math.max(0, Number(data.meta) || 0);
    var arrecadado = Math.max(0, Number(data.arrecadado) || 0);
    var falta = Math.max(0, Number(data.falta) || 0);
    var percentual = Math.max(0, Number(data.percentual) || 0);
    // Preenchimento visual sempre entre 0% e 100%.
    var barra = Math.min(100, Math.max(0, Number(data.percentualBarra) || 0));

    var root = el('div', 'meta-campanha' + (data.metaAtingida ? ' meta-campanha--atingida' : ''));
    root.appendChild(el('p', 'meta-campanha__titulo', 'Nossa meta é ' + brl.format(meta)));

    var valores = el('p', 'meta-campanha__valores');
    valores.appendChild(el('strong', null, brl.format(arrecadado)));
    valores.appendChild(document.createTextNode(' arrecadados de ' + brl.format(meta)));
    root.appendChild(valores);

    var trilho = el('div', 'meta-campanha__trilho');
    trilho.setAttribute('role', 'progressbar');
    trilho.setAttribute('aria-label', 'Progresso da arrecadação');
    trilho.setAttribute('aria-valuemin', '0');
    trilho.setAttribute('aria-valuemax', '100');
    trilho.setAttribute('aria-valuenow', String(barra));
    trilho.setAttribute('aria-valuetext', pct.format(percentual) + '% da meta');
    var preenchimento = el('div', 'meta-campanha__preenchimento');
    preenchimento.style.width = barra + '%';
    trilho.appendChild(preenchimento);
    root.appendChild(trilho);

    if (data.metaAtingida) {
      root.appendChild(
        el('p', 'meta-campanha__percentual', 'Meta atingida! ' + pct.format(percentual) + '% da meta alcançada.')
      );
      root.appendChild(
        el(
          'p',
          'meta-campanha__falta',
          'Arrecadamos ' + brl.format(arrecadado) + '. Muito obrigado a todos que ajudaram!'
        )
      );
    } else {
      root.appendChild(el('p', 'meta-campanha__percentual', pct.format(percentual) + '% da meta alcançada!'));
      root.appendChild(
        el('p', 'meta-campanha__falta', 'Faltam ' + brl.format(falta) + ' para atingir nossa meta.')
      );
    }

    container.replaceChildren(root);
  }

  function renderError(container) {
    if (container.querySelector('.meta-campanha')) return; // mantém o último valor válido
    container.replaceChildren(
      el('p', 'meta-campanha__erro', 'Não foi possível carregar o progresso da campanha agora.')
    );
  }

  function start(containers, baseUrl) {
    var apiUrl = baseUrl + '/api/campanha';
    var update = function (data) {
      containers.forEach(function (c) {
        render(c, data);
      });
    };
    var load = function () {
      return fetch(apiUrl, { cache: 'no-store' })
        .then(function (r) {
          if (!r.ok) throw new Error('HTTP ' + r.status);
          return r.json();
        })
        .then(update)
        .catch(function () {
          containers.forEach(renderError);
        });
    };

    load();
    if ('EventSource' in window) {
      var source = new EventSource(apiUrl + '/eventos');
      source.addEventListener('progresso', function (e) {
        try {
          update(JSON.parse(e.data));
        } catch (err) {
          /* ignora mensagem malformada */
        }
      });
    }
    // Garantia extra caso a conexão em tempo real caia.
    setInterval(load, 60000);
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'visible') load();
    });
  }

  window.BarraMeta = { render: render };

  var script = document.currentScript;
  var baseUrl = script && script.src ? new URL(script.src).origin : window.location.origin;
  function init() {
    var containers = Array.prototype.slice.call(document.querySelectorAll('[data-meta-campanha]'));
    if (containers.length) start(containers, baseUrl);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
