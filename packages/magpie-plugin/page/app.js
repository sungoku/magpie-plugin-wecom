'use strict';

/*
 * 插件页脚本。CSP 规定 Magpie 页面只能加载同目录脚本，内联脚本和
 * onclick 都会被丢弃，因此所有逻辑与事件绑定都放在这里。
 *
 * 两种运行模式：
 *  - Magpie 内嵌：有 window.magpie（由 _magpie/bridge.js 注入）。页面不能
 *    发网络请求，只读写插件选项并引导打开本地管理界面。
 *  - 本地管理页：由 wecom-agent-bridge 在 127.0.0.1:9099 提供，页面里注入
 *    了本次会话的 X-Bridge-Token，可完整管理 Bot。
 */
(function () {
  var $ = function (id) { return document.getElementById(id); };
  var inMagpie = typeof window.magpie === 'object' && window.magpie !== null;

  function esc(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  var toastTimer = 0;
  function showToast(message, kind) {
    var el = $('toast');
    if (!el) return;
    el.textContent = message;
    el.className = 'toast' + (kind ? ' ' + kind : '');
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.hidden = true; }, 4200);
  }

  function clampInt(value, min, max, fallback) {
    var n = parseInt(value, 10);
    if (!isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, n));
  }

  if (inMagpie) {
    initMagpie();
  } else {
    initStandalone();
  }

  /* ======================= Magpie 内嵌模式 ======================= */

  function initMagpie() {
    document.body.dataset.mode = 'magpie';
    var panel = $('magpie-panel');
    panel.hidden = false;
    $('subtitle').textContent = '通知设置 · Bot 管理请打开本地管理界面';

    var api = window.magpie;
    var enabled = $('mg-enabled');
    var minDuration = $('mg-min-duration');
    var approvalWait = $('mg-approval-wait');
    var notifyUrl = $('mg-notify-url');
    var autoStart = $('mg-autostart');
    var statusEl = $('mg-status');
    var saveBtn = $('mg-save');
    var options = {};

    function setStatus(text, kind) {
      statusEl.textContent = text || '';
      statusEl.className = 'status-inline' + (kind ? ' ' + kind : '');
    }

    function serviceBase(url) {
      try {
        var u = new URL(url);
        return u.protocol + '//' + u.host + '/';
      } catch (e) {
        return 'http://127.0.0.1:9099/';
      }
    }

    function syncServiceUrl() {
      $('mg-service-url').value = serviceBase(notifyUrl.value);
    }

    function fillForm() {
      enabled.checked = options.enabled !== false;
      minDuration.value = Number.isFinite(Number(options.minDurationSec))
        ? Number(options.minDurationSec)
        : 3;
      approvalWait.value = Number.isFinite(Number(options.approvalWaitSec))
        ? Number(options.approvalWaitSec)
        : 10;
      notifyUrl.value = typeof options.notifyUrl === 'string' && options.notifyUrl
        ? options.notifyUrl
        : 'http://127.0.0.1:9099/notify';
      autoStart.checked = options.autoStartService === true;
      syncServiceUrl();
    }

    async function loadOptions() {
      try {
        options = (await api.options.get()) || {};
        fillForm();
      } catch (e) {
        setStatus('读取 Magpie 选项失败：' + (e && e.message ? e.message : e), 'err');
      }
    }

    notifyUrl.addEventListener('input', syncServiceUrl);

    $('mg-open').addEventListener('click', function () {
      // The frame may navigate itself even under sandbox="allow-scripts";
      // top-level navigation is what the sandbox forbids.
      window.location.assign(serviceBase(notifyUrl.value));
    });

    saveBtn.addEventListener('click', async function () {
      var next = Object.assign({}, options, {
        enabled: enabled.checked,
        minDurationSec: clampInt(minDuration.value, 0, 3600, 3),
        approvalWaitSec: clampInt(approvalWait.value, 0, 300, 10),
        notifyUrl: notifyUrl.value.trim() || 'http://127.0.0.1:9099/notify',
        autoStartService: autoStart.checked,
        gatewayTimeoutMs: Number(options.gatewayTimeoutMs) || 3000
      });
      saveBtn.disabled = true;
      setStatus('正在保存…', '');
      try {
        options = (await api.options.set(next)) || next;
        fillForm();
        setStatus('已保存，设置已应用', 'ok');
      } catch (e) {
        setStatus('保存失败：' + (e && e.message ? e.message : e), 'err');
      } finally {
        saveBtn.disabled = false;
      }
    });

    // The bridge sends hello as soon as it loads; don't let a missing
    // answer keep the form blank forever.
    Promise.race([
      Promise.resolve(api.ready).catch(function () { return null; }),
      new Promise(function (resolve) { setTimeout(resolve, 3000); })
    ]).then(loadOptions);
  }

  /* ======================= 本地管理界面模式 ======================= */

  function initStandalone() {
    document.body.dataset.mode = 'standalone';
    var panel = $('standalone-panel');
    panel.hidden = false;
    $('header-actions').hidden = false;
    $('subtitle').textContent = '本地管理界面 · 企业微信官方 WSS 长连接';

    var token = window.__BRIDGE_TOKEN__ || '';
    var base = window.__BRIDGE_BASE__ || '';
    var expected = window.location.protocol.indexOf('http') === 0
      ? window.location.origin + '/'
      : 'http://127.0.0.1:9099/';
    $('expected-url').textContent = expected;

    if (!token) {
      $('token-warning').hidden = false;
      $('btn-save').disabled = true;
      $('btn-save-bottom').disabled = true;
      $('btn-toggle').disabled = true;
      $('btn-add').disabled = true;
      return;
    }

    var botList = $('bot-list');
    var toggleBtn = $('btn-toggle');
    var saveButtons = [$('btn-save'), $('btn-save-bottom')];

    var cfg = { bots: [], agents: {} };
    var running = false;
    var busy = false;
    var authorized = true;
    var pollTimer = 0;

    function api(path, init) {
      var opts = init || {};
      var headers = Object.assign({}, opts.headers || {}, { 'X-Bridge-Token': token });
      if (opts.body) headers['Content-Type'] = 'application/json';
      return fetch(base + path, Object.assign({}, opts, { headers: headers, cache: 'no-store' }))
        .then(function (res) {
          return res.json().catch(function () { return null; }).then(function (data) {
            if (!res.ok) {
              var err = new Error((data && data.error) || ('HTTP ' + res.status));
              err.status = res.status;
              throw err;
            }
            return data;
          });
        });
    }

    function handleError(e) {
      var message = e && e.message ? e.message : String(e);
      if (e && e.status === 401) {
        authorized = false;
        $('token-warning').hidden = false;
        clearInterval(pollTimer);
        showToast('管理令牌已失效，请刷新页面', 'err');
        return;
      }
      showToast(message, 'err');
    }

    function setBadge(kind, text) {
      var badge = $('status-badge');
      badge.className = 'badge badge-' + kind;
      $('status-text').textContent = text;
    }

    function setBusy(value) {
      busy = value;
      toggleBtn.disabled = value;
      saveButtons.forEach(function (b) { b.disabled = value; });
    }

    function agentNames() {
      var names = Object.keys(cfg.agents || {});
      return names.length ? names : ['claude', 'opencode', 'sh'];
    }

    function agentOptions(selected) {
      var names = agentNames();
      if (selected && names.indexOf(selected) === -1) names.push(selected);
      return names.map(function (name) {
        var desc = cfg.agents && cfg.agents[name] ? cfg.agents[name].description : '';
        return '<option value="' + esc(name) + '"' +
          (name === selected ? ' selected' : '') + '>' +
          esc(name + (desc ? ' — ' + desc : '')) + '</option>';
      }).join('');
    }

    function normalizeConfig(data) {
      var out = data && typeof data === 'object' ? data : {};
      out.bots = Array.isArray(out.bots) ? out.bots : [];
      out.agents = out.agents && typeof out.agents === 'object' ? out.agents : {};
      return out;
    }

    function renderBots() {
      if (!cfg.bots.length) {
        botList.innerHTML = '<div class="card"><p class="muted">暂未添加企微 Bot。点击右上角“+ 添加 Bot”开始配置。</p></div>';
        return;
      }
      botList.innerHTML = cfg.bots.map(function (b, i) {
        var users = (b.allowedUsers || []).join(', ');
        var secretHint = b.secretSet
          ? '已保存 ' + (b.secretMasked || '') + '（留空保持不变）'
          : '从企微后台复制';
        var warn = (b.allowedUsers || []).length === 0
          ? '<div class="warn">未设置白名单：任何能联系此 Bot 的企微用户都可执行指令' +
            (b.defaultAgent === 'sh' ? '，包括任意 Shell 命令' : '') + '。</div>'
          : '';
        return '<div class="card bot-card" data-idx="' + i + '" data-bot-id="' + esc(b.id) + '">' +
          '<div class="card-head">' +
          '<input class="bot-name" data-field="name" value="' + esc(b.name) + '" placeholder="角色名称">' +
          '<button class="btn btn-danger" type="button" data-del="' + i + '">删除</button>' +
          '</div>' +
          '<div class="form-grid">' +
          '<label class="field"><span>Bot ID</span>' +
          '<input data-field="botId" value="' + esc(b.botId) + '" spellcheck="false" placeholder="从企微后台复制"></label>' +
          '<label class="field"><span>Secret</span>' +
          '<input type="password" data-field="secret" value="" spellcheck="false" placeholder="' + esc(secretHint) + '"></label>' +
          '<label class="field"><span>绑定的 Agent</span>' +
          '<select data-field="defaultAgent">' + agentOptions(b.defaultAgent) + '</select></label>' +
          '<label class="field"><span>授权用户白名单（逗号分隔）</span>' +
          '<input data-field="allowedUsers" value="' + esc(users) + '" placeholder="留空 = 不限制"></label>' +
          '<label class="field full"><span>角色人设前缀（可选）</span>' +
          '<textarea data-field="promptPrefix" placeholder="例如：你是资深 Go 架构师，严格遵循 SOLID 原则...">' +
          esc(b.promptPrefix || '') + '</textarea></label>' +
          '</div>' + warn + '</div>';
      }).join('');
    }

    function field(card, name) {
      return card.querySelector('[data-field="' + name + '"]');
    }

    function splitUsers(value) {
      return String(value || '').split(',').map(function (s) { return s.trim(); }).filter(Boolean);
    }

    function collectBots() {
      return Array.prototype.map.call(botList.querySelectorAll('[data-bot-id]'), function (card) {
        var bot = {
          id: card.dataset.botId,
          name: field(card, 'name').value.trim(),
          botId: field(card, 'botId').value.trim(),
          defaultAgent: field(card, 'defaultAgent').value,
          allowedUsers: splitUsers(field(card, 'allowedUsers').value),
          promptPrefix: field(card, 'promptPrefix').value.trim()
        };
        var secret = field(card, 'secret').value.trim();
        if (secret) bot.secret = secret;
        return bot;
      });
    }

    function loadConfig() {
      return api('/api/config').then(function (data) {
        cfg = normalizeConfig(data);
        renderBots();
      });
    }

    function refreshStatus() {
      if (busy || !authorized) return Promise.resolve();
      return api('/api/status').then(function (data) {
        running = Boolean(data && data.running);
        setBadge(running ? 'ok' : 'idle', running ? '运行中' : '已停止');
        toggleBtn.textContent = running ? '停止服务' : '启动服务';
      }).catch(function (e) {
        if (e && e.status === 401) {
          handleError(e);
        } else {
          setBadge('err', '无法连接');
          toggleBtn.textContent = '启动服务';
        }
      });
    }

    function save() {
      if (busy) return;
      setBusy(true);
      var payload = {
        bots: collectBots()
      };
      api('/api/config', { method: 'POST', body: JSON.stringify(payload) })
        .then(function () {
          showToast(
            running ? '配置已保存，Bot 连接已热重载' : '配置已保存，请点击“启动服务”建立连接',
            'ok'
          );
          return Promise.all([loadConfig(), refreshStatus()]);
        })
        .catch(handleError)
        .then(function () { setBusy(false); });
    }

    function toggleService() {
      if (busy) return;
      setBusy(true);
      var path = running ? '/api/service/stop' : '/api/service/start';
      api(path, { method: 'POST' })
        .then(function () {
          showToast(running ? '服务已停止' : '服务已启动', 'ok');
          return refreshStatus();
        })
        .catch(handleError)
        .then(function () { setBusy(false); });
    }

    function addBot() {
      cfg.bots = collectBots();
      cfg.bots.push({
        id: 'bot-' + Date.now().toString(36),
        name: '新 Bot',
        botId: '',
        defaultAgent: agentNames()[0],
        allowedUsers: [],
        promptPrefix: ''
      });
      renderBots();
      var cards = botList.querySelectorAll('[data-bot-id]');
      var last = cards[cards.length - 1];
      if (last) field(last, 'name').focus();
    }

    botList.addEventListener('click', function (event) {
      var button = event.target.closest('[data-del]');
      if (!button) return;
      var card = button.closest('[data-bot-id]');
      if (!card) return;
      if (button.dataset.confirm === '1') {
        card.remove();
        return;
      }
      button.dataset.confirm = '1';
      button.textContent = '确认删除';
      setTimeout(function () {
        if (button.isConnected) {
          button.dataset.confirm = '';
          button.textContent = '删除';
        }
      }, 3000);
    });

    $('btn-add').addEventListener('click', addBot);
    $('btn-save').addEventListener('click', save);
    $('btn-save-bottom').addEventListener('click', save);
    toggleBtn.addEventListener('click', toggleService);

    Promise.all([loadConfig(), refreshStatus()]).catch(handleError);
    pollTimer = setInterval(function () {
      if (!document.hidden) refreshStatus();
    }, 8000);
  }
})();
