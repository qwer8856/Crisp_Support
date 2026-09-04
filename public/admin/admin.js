(() => {
  const $ = selector => document.querySelector(selector);
  const loginView = $('#loginView');
  const appView = $('#appView');
  const tokenKey = 'blsupport:adminToken';
  const collapsedGroupsKey = 'blsupport:collapsedConversationGroups';
  const presenceFreshMs = 45000;
  let token = sessionStorage.getItem(tokenKey) || '';
  let socket = null;
  let conversations = [];
  let sites = [];
  let active = null;
  let filter = 'all';
  let siteFilter = 'all';
  let collapsedConversationGroups = new Set();
  let keywordReplies = [];
  let editingKeywordReplyId = null;
  let keywordReplyRequest = 0;
  let crispRequest = 0;
  let presenceSummaryTimer = null;
  let presenceSummaryInFlight = false;
  let activePresenceTimer = null;
  let activePresenceRequest = 0;
  let searchAutofillTimer = null;
  let searchUnlockedByUser = false;
  let crispSettings = {
    enabled: false,
    websiteId: '',
    tokenIdentifierConfigured: false,
    tokenIdentifierHint: '',
    tokenKeyConfigured: false,
    webhookSecretConfigured: false,
    webhookUrl: ''
  };
  let systemSettings = {
    publicBaseUrl: '',
    telegramBotTokenConfigured: false,
    telegramBotTokenHint: '',
    telegramWebhookSecretConfigured: false,
    telegramWebhookActive: false,
    telegramWebhookStatusKnown: false
  };

  try {
    const savedGroups = JSON.parse(localStorage.getItem(collapsedGroupsKey) || '[]');
    if (Array.isArray(savedGroups)) collapsedConversationGroups = new Set(savedGroups.map(String));
  } catch {
    collapsedConversationGroups = new Set();
  }

  function saveCollapsedConversationGroups() {
    try {
      localStorage.setItem(collapsedGroupsKey, JSON.stringify([...collapsedConversationGroups]));
    } catch {
      // The current view still works when browser storage is unavailable.
    }
  }

  async function api(url, options = {}) {
    options.headers = Object.assign({}, options.headers || {}, token ? { Authorization: `Bearer ${token}` } : {});
    const response = await fetch(url, options);
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      if (response.status === 401) logout(false);
      throw new Error(data.error || '请求失败');
    }
    return data;
  }

  async function copyText(value) {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(value);
      return;
    }
    const temporary = document.createElement('textarea');
    temporary.value = value;
    temporary.readOnly = true;
    temporary.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0';
    document.body.appendChild(temporary);
    temporary.select();
    let copied = false;
    try {
      copied = document.execCommand('copy');
    } finally {
      temporary.remove();
    }
    if (!copied) throw new Error('copy failed');
    getSelection()?.removeAllRanges();
  }

  function formatTime(value) {
    if (!value) return '';
    const date = new Date(value);
    const now = new Date();
    return date.toDateString() === now.toDateString()
      ? date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      : date.toLocaleDateString();
  }

  function displayName(conversation) {
    return conversation.display_name || conversation.email || conversation.external_user_id || `访客 ${String(conversation.visitor_key || '').slice(0, 8)}`;
  }

  function displayKeywordGroup(value) {
    return String(value || '').split(/[\r\n,，、|;；]+/u).map(item => item.trim()).filter(Boolean).join(' / ');
  }

  function conversationSiteKey(conversation) {
    return String(conversation.site_key || conversation.site_name || conversation.site_url || 'unknown-site');
  }

  function conversationSiteLabel(conversation) {
    const name = String(conversation.site_name || '').trim();
    if (name) return name;
    const address = String(conversation.site_url || '').trim().split(/[\s,]+/)[0];
    if (!address) return '未识别网站';
    try {
      return new URL(address).hostname || address;
    } catch {
      return address;
    }
  }

  function conversationPresenceState(conversation) {
    if (conversation?.is_online === null || conversation?.is_online === undefined) return 'unknown';
    if (!Number(conversation.is_online)) return 'offline';
    if (conversation.presence_age_seconds === null || conversation.presence_age_seconds === undefined) return 'unknown';
    const serverAge = Math.max(0, Number(conversation.presence_age_seconds) || 0) * 1000;
    const receivedAt = Number(conversation._presence_received_at) || Date.now();
    const clientAge = Math.max(0, Date.now() - receivedAt);
    return serverAge + clientAge <= presenceFreshMs ? 'online' : 'unknown';
  }

  function conversationPresenceLabel(conversation) {
    const state = conversationPresenceState(conversation);
    if (state === 'online') return '在线';
    if (state === 'offline') return '离线';
    return '检测中';
  }

  function stopActivePresencePolling() {
    activePresenceRequest += 1;
    if (activePresenceTimer) clearInterval(activePresenceTimer);
    activePresenceTimer = null;
  }

  function stopPresencePolling() {
    stopActivePresencePolling();
    if (presenceSummaryTimer) clearInterval(presenceSummaryTimer);
    presenceSummaryTimer = null;
  }

  function stopSearchAutofillGuard() {
    if (searchAutofillTimer) clearInterval(searchAutofillTimer);
    searchAutofillTimer = null;
  }

  function unlockConversationSearch() {
    searchUnlockedByUser = true;
    $('#searchInput').readOnly = false;
    stopSearchAutofillGuard();
  }

  function resetConversationSearch() {
    const searchInput = $('#searchInput');
    searchUnlockedByUser = false;
    searchInput.readOnly = true;
    searchInput.value = '';
    stopSearchAutofillGuard();

    const startedAt = Date.now();
    searchAutofillTimer = setInterval(() => {
      if (searchUnlockedByUser || Date.now() - startedAt >= 4000) {
        stopSearchAutofillGuard();
        return;
      }
      if (!searchInput.value) return;
      searchInput.value = '';
      renderConversations();
    }, 100);
  }

  function loginReady() {
    loginView.classList.add('hidden');
    appView.classList.remove('hidden');
    resetConversationSearch();
    loadConversations().then(() => refreshPresenceSummary()).catch(() => {});
    startPresenceSummaryPolling();
    connectSocket();
  }

  function logout(reload = true) {
    token = '';
    sessionStorage.removeItem(tokenKey);
    stopPresencePolling();
    stopSearchAutofillGuard();
    if (socket) socket.disconnect();
    socket = null;
    if (reload) {
      location.reload();
    } else {
      appView.classList.add('hidden');
      loginView.classList.remove('hidden');
    }
  }

  $('#loginForm').addEventListener('submit', async event => {
    event.preventDefault();
    $('#loginError').textContent = '';
    try {
      const data = await api('/api/admin/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: $('#email').value, password: $('#password').value })
      });
      token = data.token;
      sessionStorage.setItem(tokenKey, token);
      loginReady();
    } catch (error) {
      $('#loginError').textContent = error.message;
    }
  });

  $('#logoutBtn').addEventListener('click', () => logout());
  $('#refreshBtn').addEventListener('click', () => loadConversations().then(() => refreshPresenceSummary()).catch(() => {}));

  function showSettings() {
    stopActivePresencePolling();
    appView.classList.add('settings-open');
    $('.inbox').classList.add('hidden');
    $('.chat-panel').classList.add('hidden');
    $('#visitorPanel').classList.add('hidden');
    $('#settingsView').classList.remove('hidden');
    $('#inboxNavBtn').classList.remove('active');
    $('#settingsNavBtn').classList.add('active');
    Promise.all([loadSites(), loadSystemSettings()]).catch(() => {});
  }

  function showInbox() {
    appView.classList.remove('settings-open');
    $('.inbox').classList.remove('hidden');
    $('.chat-panel').classList.remove('hidden');
    $('#visitorPanel').classList.remove('hidden');
    $('#settingsView').classList.add('hidden');
    $('#settingsNavBtn').classList.remove('active');
    $('#inboxNavBtn').classList.add('active');
    if (active) startActivePresencePolling();
  }

  $('#settingsNavBtn').addEventListener('click', showSettings);
  $('#mobileSettingsBtn').addEventListener('click', showSettings);
  $('#inboxNavBtn').addEventListener('click', showInbox);
  $('#closeSettingsBtn').addEventListener('click', showInbox);

  async function loadSites(preferredId = '') {
    try {
      const data = await api('/api/admin/sites');
      sites = data.sites || [];
      const select = $('#embedSiteSelect');
      const previous = preferredId || select.value;
      select.innerHTML = '';
      select.disabled = !sites.length;
      if (!sites.length) {
        const option = document.createElement('option');
        option.value = '';
        option.textContent = '暂无网站';
        select.appendChild(option);
      } else {
        sites.forEach(site => {
          const option = document.createElement('option');
          option.value = site.id;
          option.textContent = site.allowed_origins || site.name;
          select.appendChild(option);
        });
        if (previous && sites.some(site => String(site.id) === String(previous))) select.value = String(previous);
      }
      renderSettings();
      await Promise.all([loadKeywordReplies(), loadCrispSettings()]);
    } catch (error) {
      $('#siteFormStatus').textContent = error.message;
      throw error;
    }
  }

  function applySystemSettings(data) {
    systemSettings = { ...systemSettings, ...data };
    $('#publicBaseUrlSetting').value = data.publicBaseUrl || '';
    $('#telegramBotToken').value = '';
    $('#telegramBotToken').placeholder = data.telegramBotTokenConfigured
      ? `已保存 ${data.telegramBotTokenHint}，留空不修改`
      : '从 BotFather 获取';
    $('#telegramWebhookSecret').value = '';
    $('#telegramWebhookSecret').placeholder = data.telegramWebhookSecretConfigured
      ? '已加密保存，留空不修改'
      : '留空自动生成';
    setSecretVisibility('telegramBotToken', false);
    setSecretVisibility('telegramWebhookSecret', false);
    renderTelegramSettings();
    renderCrispSettings();
  }

  async function loadSystemSettings() {
    try {
      const settings = await api('/api/admin/settings');
      applySystemSettings({ ...settings, telegramWebhookActive: false, telegramWebhookStatusKnown: false });
      if (settings.telegramBotTokenConfigured) {
        try {
          const status = await api('/api/admin/telegram/status');
          applySystemSettings({
            ...settings,
            telegramWebhookActive: status.webhookActive,
            telegramWebhookStatusKnown: true
          });
        } catch (error) {
          $('#telegramStatusMessage').textContent = `Telegram 状态读取失败：${error.message}`;
        }
      }
    } catch (error) {
      $('#telegramStatusMessage').textContent = error.message;
    }
  }

  function selectedSite() {
    return sites.find(site => String(site.id) === $('#embedSiteSelect').value) || sites[0];
  }

  function renderSettings() {
    const site = selectedSite();
    if (!site) {
      renderCrispSettings();
      renderTelegramSettings();
      return;
    }
    renderCrispSettings();
    renderTelegramSettings();
  }

  function renderTelegramSettings() {
    const site = selectedSite();
    const input = $('#telegramChatId');
    const saveButton = $('#saveTelegramBtn');
    const webhookButton = $('#configureWebhookBtn');
    const discoverButton = $('#discoverTelegramChatsBtn');
    const clearTokenButton = $('#clearTelegramTokenBtn');
    const regenerateSecretButton = $('#regenerateWebhookSecretBtn');
    const status = $('#telegramGlobalStatus');
    input.disabled = !site;
    saveButton.disabled = !site;
    input.value = site?.telegram_chat_id || '';
    $('#telegramWebhookUrl').textContent = systemSettings.publicBaseUrl
      ? `Webhook: ${systemSettings.publicBaseUrl}/api/telegram/webhook`
      : '保存公网 HTTPS 客服地址后生成 Webhook 地址';

    status.className = 'integration-status';
    const webhookAddressReady = systemSettings.publicBaseUrl.startsWith('https://');
    if (systemSettings.telegramWebhookStatusKnown && systemSettings.telegramWebhookActive) {
      status.textContent = 'Webhook 运行中';
      status.classList.add('ready');
    } else if (systemSettings.telegramBotTokenConfigured && systemSettings.telegramWebhookSecretConfigured && webhookAddressReady) {
      status.textContent = systemSettings.telegramWebhookStatusKnown ? 'Webhook 已停止' : '配置已保存';
      status.classList.add('warning');
    } else if (systemSettings.telegramBotTokenConfigured) {
      status.textContent = systemSettings.publicBaseUrl && !webhookAddressReady ? '公网地址需 HTTPS' : '配置未完整';
      status.classList.add('warning');
    } else {
      status.textContent = 'Bot 未配置';
    }
    webhookButton.disabled = !(systemSettings.telegramBotTokenConfigured && systemSettings.telegramWebhookSecretConfigured && webhookAddressReady);
    webhookButton.textContent = systemSettings.telegramWebhookActive ? '停止 Webhook' : '启用 Webhook';
    webhookButton.classList.toggle('copy-btn', !systemSettings.telegramWebhookActive);
    webhookButton.classList.toggle('danger-link', systemSettings.telegramWebhookActive);
    discoverButton.disabled = !systemSettings.telegramBotTokenConfigured;
    clearTokenButton.disabled = !systemSettings.telegramBotTokenConfigured;
    regenerateSecretButton.disabled = !systemSettings.telegramBotTokenConfigured;
  }

  function renderCrispSettings() {
    const site = selectedSite();
    const fields = $('#crispFields');
    fields.disabled = !site;
    $('#saveCrispSettingsBtn').disabled = !site;
    $('#testCrispConnectionBtn').disabled = !site || !crispSettings.tokenIdentifierConfigured || !crispSettings.tokenKeyConfigured || !crispSettings.websiteId;
    $('#regenerateCrispSecretBtn').disabled = !site;
    $('#copyCrispWebhookBtn').disabled = !site || !crispSettings.webhookUrl;
    $('#crispWebsiteId').value = crispSettings.websiteId || '';
    $('#crispTokenIdentifier').placeholder = crispSettings.tokenIdentifierConfigured
      ? `已保存 ${crispSettings.tokenIdentifierHint}，留空不修改`
      : 'Crisp API Token ID';
    $('#crispTokenKey').placeholder = crispSettings.tokenKeyConfigured ? '已加密保存，留空不修改' : 'Crisp API Token Key';
    $('#crispWebhookUrl').value = crispSettings.webhookUrl || '';
    const status = $('#crispStatus');
    status.className = 'integration-status';
    const complete = crispSettings.websiteId && crispSettings.tokenIdentifierConfigured && crispSettings.tokenKeyConfigured;
    if (crispSettings.enabled && complete) {
      status.textContent = '托管中';
      status.classList.add('ready');
    } else if (complete) {
      status.textContent = '已配置';
      status.classList.add('warning');
    } else {
      status.textContent = site ? '待配置' : '请选择网站';
    }
  }

  function secretFieldDefinition(field) {
    const site = selectedSite();
    const definitions = {
      tokenIdentifier: {
        input: $('#crispTokenIdentifier'),
        label: 'Website Token ID',
        configured: crispSettings.tokenIdentifierConfigured,
        endpoint: site ? `/api/admin/sites/${site.id}/crisp/secret/tokenIdentifier` : '',
        status: $('#crispStatusMessage'),
        siteId: site?.id
      },
      tokenKey: {
        input: $('#crispTokenKey'),
        label: 'Website Token Key',
        configured: crispSettings.tokenKeyConfigured,
        endpoint: site ? `/api/admin/sites/${site.id}/crisp/secret/tokenKey` : '',
        status: $('#crispStatusMessage'),
        siteId: site?.id
      },
      crispWebhookUrl: {
        input: $('#crispWebhookUrl'),
        label: 'Website Hook 回调地址',
        configured: Boolean(crispSettings.webhookUrl),
        status: $('#crispStatusMessage')
      },
      telegramBotToken: {
        input: $('#telegramBotToken'),
        label: 'Bot Token',
        configured: systemSettings.telegramBotTokenConfigured,
        endpoint: '/api/admin/settings/secret/telegramBotToken',
        status: $('#telegramStatusMessage')
      },
      telegramWebhookSecret: {
        input: $('#telegramWebhookSecret'),
        label: 'Webhook 安全密钥',
        configured: systemSettings.telegramWebhookSecretConfigured,
        endpoint: '/api/admin/settings/secret/telegramWebhookSecret',
        status: $('#telegramStatusMessage')
      }
    };
    return definitions[field] || null;
  }

  function setSecretVisibility(field, visible) {
    const definition = secretFieldDefinition(field);
    if (!definition) return;
    const { input, label } = definition;
    const button = document.querySelector(`[data-secret-field="${field}"]`);
    if (!input || !button) return;
    input.type = visible ? 'text' : 'password';
    button.setAttribute('aria-pressed', String(visible));
    button.setAttribute('aria-label', `${visible ? '隐藏' : '显示'} ${label}`);
    button.title = `${visible ? '隐藏' : '显示'} ${label}`;
    button.querySelector('.secret-eye').classList.toggle('hidden', visible);
    button.querySelector('.secret-eye-off').classList.toggle('hidden', !visible);
  }

  function resetCrispSecretInputs() {
    $('#crispTokenIdentifier').value = '';
    $('#crispTokenKey').value = '';
    $('#crispWebhookUrl').value = '';
    setSecretVisibility('tokenIdentifier', false);
    setSecretVisibility('tokenKey', false);
    setSecretVisibility('crispWebhookUrl', false);
  }

  async function toggleSecretField(field) {
    const definition = secretFieldDefinition(field);
    if (!definition) return;
    const { input, configured, endpoint, status, siteId } = definition;
    const button = document.querySelector(`[data-secret-field="${field}"]`);
    if (input.type === 'text') {
      setSecretVisibility(field, false);
      return;
    }
    if (!input.value && configured && endpoint) {
      button.disabled = true;
      status.textContent = '';
      try {
        const data = await api(endpoint);
        if (siteId && selectedSite()?.id !== siteId) return;
        input.value = data.value || '';
      } catch (error) {
        status.textContent = error.message;
        return;
      } finally {
        button.disabled = false;
      }
    }
    setSecretVisibility(field, true);
    input.focus({ preventScroll: true });
    if (!input.readOnly) input.setSelectionRange(input.value.length, input.value.length);
  }

  async function loadCrispSettings() {
    const requestId = ++crispRequest;
    const site = selectedSite();
    crispSettings = {
      enabled: site?.integration_mode === 'crisp',
      websiteId: site?.crisp_website_id || '',
      tokenIdentifierConfigured: false,
      tokenIdentifierHint: '',
      tokenKeyConfigured: false,
      webhookSecretConfigured: false,
      webhookUrl: ''
    };
    resetCrispSecretInputs();
    renderCrispSettings();
    if (!site) return;
    try {
      const data = await api(`/api/admin/sites/${site.id}/crisp`);
      if (requestId !== crispRequest || selectedSite()?.id !== site.id) return;
      crispSettings = data.crisp;
      renderCrispSettings();
    } catch (error) {
      if (requestId === crispRequest) $('#crispStatusMessage').textContent = error.message;
    }
  }

  function resetKeywordReplyForm() {
    editingKeywordReplyId = null;
    $('#keywordReplyForm').reset();
    $('#keywordMatchType').value = 'contains';
    $('#keywordEnabled').checked = true;
    $('#saveKeywordReplyBtn').textContent = '添加规则';
    $('#cancelKeywordEditBtn').classList.add('hidden');
  }

  function renderKeywordReplies() {
    const list = $('#keywordReplyList');
    list.innerHTML = '';
    $('#keywordRuleCount').textContent = `${keywordReplies.length} 条`;
    if (!selectedSite()) {
      const empty = document.createElement('div');
      empty.className = 'keyword-empty';
      empty.textContent = '请先添加网站';
      list.appendChild(empty);
      return;
    }
    if (!keywordReplies.length) {
      const empty = document.createElement('div');
      empty.className = 'keyword-empty';
      empty.textContent = '暂无关键词规则';
      list.appendChild(empty);
      return;
    }
    keywordReplies.forEach(rule => {
      const row = document.createElement('div');
      row.className = `keyword-reply-row${rule.enabled ? '' : ' disabled'}`;

      const ruleName = document.createElement('div');
      ruleName.className = 'keyword-rule-name';
      const matchType = document.createElement('span');
      matchType.className = 'keyword-match-type';
      matchType.textContent = rule.match_type === 'exact' ? '完全一致' : '包含';
      const keyword = document.createElement('strong');
      keyword.textContent = displayKeywordGroup(rule.keyword);
      keyword.title = '任意一个关键词命中即可触发';
      ruleName.append(matchType, keyword);

      const reply = document.createElement('p');
      reply.textContent = rule.reply_text;

      const actions = document.createElement('div');
      actions.className = 'keyword-rule-actions';
      const enabledLabel = document.createElement('label');
      enabledLabel.className = 'keyword-enabled';
      const enabled = document.createElement('input');
      enabled.type = 'checkbox';
      enabled.checked = Boolean(rule.enabled);
      const enabledText = document.createElement('span');
      enabledText.textContent = '启用';
      enabledLabel.append(enabled, enabledText);
      enabled.addEventListener('change', async () => {
        enabled.disabled = true;
        $('#keywordReplyStatus').textContent = '';
        try {
          const data = await api(`/api/admin/keyword-replies/${rule.id}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ enabled: enabled.checked })
          });
          Object.assign(rule, data.keywordReply);
          renderKeywordReplies();
        } catch (error) {
          enabled.checked = !enabled.checked;
          enabled.disabled = false;
          $('#keywordReplyStatus').textContent = error.message;
        }
      });

      const edit = document.createElement('button');
      edit.type = 'button';
      edit.className = 'secondary-btn';
      edit.textContent = '编辑';
      edit.addEventListener('click', () => {
        editingKeywordReplyId = rule.id;
        $('#keywordInput').value = rule.keyword;
        $('#keywordMatchType').value = rule.match_type;
        $('#keywordReplyText').value = rule.reply_text;
        $('#keywordEnabled').checked = Boolean(rule.enabled);
        $('#saveKeywordReplyBtn').textContent = '保存修改';
        $('#cancelKeywordEditBtn').classList.remove('hidden');
        $('#keywordReplyStatus').textContent = '';
        $('#keywordInput').focus();
      });

      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'danger-link';
      remove.textContent = '删除';
      remove.addEventListener('click', async () => {
        if (!confirm(`确定删除关键词“${rule.keyword}”吗？`)) return;
        remove.disabled = true;
        $('#keywordReplyStatus').textContent = '';
        try {
          await api(`/api/admin/keyword-replies/${rule.id}`, { method: 'DELETE' });
          if (editingKeywordReplyId === rule.id) resetKeywordReplyForm();
          $('#keywordReplyStatus').textContent = '规则已删除';
          await loadKeywordReplies({ resetForm: false });
        } catch (error) {
          remove.disabled = false;
          $('#keywordReplyStatus').textContent = error.message;
        }
      });
      actions.append(enabledLabel, edit, remove);
      row.append(ruleName, reply, actions);
      list.appendChild(row);
    });
  }

  async function loadKeywordReplies(options = {}) {
    const requestId = ++keywordReplyRequest;
    const site = selectedSite();
    if (options.resetForm !== false) resetKeywordReplyForm();
    $('#keywordReplyFields').disabled = !site;
    keywordReplies = [];
    renderKeywordReplies();
    if (!site) return;
    try {
      const data = await api(`/api/admin/sites/${site.id}/keyword-replies`);
      if (requestId !== keywordReplyRequest || selectedSite()?.id !== site.id) return;
      keywordReplies = data.keywordReplies || [];
      renderKeywordReplies();
    } catch (error) {
      if (requestId === keywordReplyRequest) $('#keywordReplyStatus').textContent = error.message;
    }
  }

  $('#addSiteForm').addEventListener('submit', async event => {
    event.preventDefault();
    const button = $('#addSiteBtn');
    const status = $('#siteFormStatus');
    button.disabled = true;
    status.textContent = '';
    try {
      const data = await api('/api/admin/sites', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ websiteUrl: $('#websiteUrl').value, integrationMode: 'crisp' })
      });
      $('#websiteUrl').value = '';
      status.textContent = '网站已添加';
      await loadSites(data.site.id);
      loadConversations();
    } catch (error) {
      status.textContent = error.message;
    } finally {
      button.disabled = false;
    }
  });

  $('#embedSiteSelect').addEventListener('change', async () => {
    $('#siteFormStatus').textContent = '';
    $('#telegramStatusMessage').textContent = '';
    $('#crispStatusMessage').textContent = '';
    $('#keywordReplyStatus').textContent = '';
    renderSettings();
    await Promise.all([loadKeywordReplies(), loadCrispSettings()]);
  });

  document.querySelectorAll('.secret-toggle').forEach(button => {
    button.addEventListener('click', () => toggleSecretField(button.dataset.secretField));
  });

  $('#saveCrispSettingsBtn').addEventListener('click', async () => {
    const site = selectedSite();
    if (!site) return;
    const button = $('#saveCrispSettingsBtn');
    const status = $('#crispStatusMessage');
    button.disabled = true;
    status.textContent = '';
    try {
      const data = await api(`/api/admin/sites/${site.id}/crisp`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          enabled: true,
          websiteId: $('#crispWebsiteId').value.trim(),
          tokenIdentifier: $('#crispTokenIdentifier').value.trim(),
          tokenKey: $('#crispTokenKey').value.trim()
        })
      });
      const index = sites.findIndex(item => item.id === data.site.id);
      if (index >= 0) sites[index] = data.site;
      crispSettings = data.crisp;
      resetCrispSecretInputs();
      renderSettings();
      status.textContent = 'Crisp 托管配置已保存';
    } catch (error) {
      status.textContent = error.message;
    } finally {
      button.disabled = !selectedSite();
    }
  });

  $('#testCrispConnectionBtn').addEventListener('click', async () => {
    const site = selectedSite();
    if (!site) return;
    const button = $('#testCrispConnectionBtn');
    const status = $('#crispStatusMessage');
    button.disabled = true;
    status.textContent = '';
    try {
      const data = await api(`/api/admin/sites/${site.id}/crisp/test`, { method: 'POST' });
      status.textContent = data.websiteName ? `连接成功：${data.websiteName}` : 'Crisp 连接成功';
    } catch (error) {
      status.textContent = error.message;
    } finally {
      renderCrispSettings();
    }
  });

  $('#regenerateCrispSecretBtn').addEventListener('click', async () => {
    const site = selectedSite();
    if (!site) return;
    const button = $('#regenerateCrispSecretBtn');
    const status = $('#crispStatusMessage');
    button.disabled = true;
    status.textContent = '';
    try {
      const data = await api(`/api/admin/sites/${site.id}/crisp`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ regenerateWebhookSecret: true })
      });
      crispSettings = data.crisp;
      setSecretVisibility('crispWebhookUrl', false);
      renderCrispSettings();
      status.textContent = '回调密钥已更新，请替换 Crisp 中的 Website Hook 地址';
    } catch (error) {
      status.textContent = error.message;
    } finally {
      button.disabled = !selectedSite();
    }
  });

  $('#copyCrispWebhookBtn').addEventListener('click', async () => {
    if (!crispSettings.webhookUrl) return;
    const status = $('#crispStatusMessage');
    try {
      await copyText(crispSettings.webhookUrl);
      status.textContent = 'Website Hook 地址已复制';
    } catch {
      status.textContent = '复制失败，请重试';
    }
  });

  $('#keywordReplyForm').addEventListener('submit', async event => {
    event.preventDefault();
    const site = selectedSite();
    if (!site) return;
    const button = $('#saveKeywordReplyBtn');
    const status = $('#keywordReplyStatus');
    const editing = editingKeywordReplyId;
    button.disabled = true;
    status.textContent = '';
    const payload = {
      keyword: $('#keywordInput').value,
      replyText: $('#keywordReplyText').value,
      matchType: $('#keywordMatchType').value,
      enabled: $('#keywordEnabled').checked
    };
    try {
      await api(editing
        ? `/api/admin/keyword-replies/${editing}`
        : `/api/admin/sites/${site.id}/keyword-replies`, {
        method: editing ? 'PATCH' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      resetKeywordReplyForm();
      status.textContent = editing ? '规则已更新' : '规则已添加';
      await loadKeywordReplies({ resetForm: false });
    } catch (error) {
      status.textContent = error.message;
    } finally {
      button.disabled = !selectedSite();
    }
  });

  $('#cancelKeywordEditBtn').addEventListener('click', () => {
    resetKeywordReplyForm();
    $('#keywordReplyStatus').textContent = '';
  });

  $('#saveSystemSettingsBtn').addEventListener('click', async () => {
    const button = $('#saveSystemSettingsBtn');
    const message = $('#telegramStatusMessage');
    button.disabled = true;
    message.textContent = '';
    try {
      const data = await api('/api/admin/settings', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          publicBaseUrl: $('#publicBaseUrlSetting').value.trim(),
          telegramBotToken: $('#telegramBotToken').value.trim(),
          telegramWebhookSecret: $('#telegramWebhookSecret').value.trim()
        })
      });
      applySystemSettings(data);
      await loadCrispSettings();
      message.textContent = '系统配置已加密保存';
    } catch (error) {
      message.textContent = error.message;
    } finally {
      button.disabled = false;
    }
  });

  $('#regenerateWebhookSecretBtn').addEventListener('click', async () => {
    const button = $('#regenerateWebhookSecretBtn');
    const message = $('#telegramStatusMessage');
    button.disabled = true;
    message.textContent = '';
    try {
      const data = await api('/api/admin/settings', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ regenerateWebhookSecret: true })
      });
      applySystemSettings(data);
      message.textContent = 'Webhook 密钥已重新生成，请再次启用 Webhook';
    } catch (error) {
      message.textContent = error.message;
    } finally {
      button.disabled = false;
    }
  });

  $('#clearTelegramTokenBtn').addEventListener('click', async () => {
    if (!systemSettings.telegramBotTokenConfigured) return;
    if (!confirm('确定移除 Bot Token 并停用 Telegram Webhook 密钥吗？')) return;
    const button = $('#clearTelegramTokenBtn');
    const message = $('#telegramStatusMessage');
    button.disabled = true;
    message.textContent = '';
    try {
      const data = await api('/api/admin/settings', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clearTelegramBotToken: true })
      });
      applySystemSettings(data);
      message.textContent = 'Bot Token 已移除';
    } catch (error) {
      message.textContent = error.message;
    } finally {
      button.disabled = false;
    }
  });

  $('#discoverTelegramChatsBtn').addEventListener('click', async () => {
    const button = $('#discoverTelegramChatsBtn');
    const message = $('#telegramStatusMessage');
    button.disabled = true;
    message.textContent = '';
    try {
      const data = await api('/api/admin/telegram/chats');
      const chats = data.chats || [];
      const options = $('#telegramChatOptions');
      options.innerHTML = '';
      chats.forEach(chat => {
        const option = document.createElement('option');
        option.value = chat.id;
        option.label = chat.title;
        options.appendChild(option);
      });
      if (chats.length === 1) $('#telegramChatId').value = chats[0].id;
      const restored = data.webhookPaused && data.webhookRestored ? '，Webhook 已自动恢复' : '';
      message.textContent = chats.length
        ? `已读取 ${chats.length} 个群组${chats.length === 1 ? '，群组 ID 已填入' : '，请在群组 ID 输入框中选择'}${restored}`
        : '没有读取到群组，请先在目标群组中发送一条消息';
    } catch (error) {
      message.textContent = error.message;
    } finally {
      button.disabled = !systemSettings.telegramBotTokenConfigured;
    }
  });

  $('#saveTelegramBtn').addEventListener('click', async () => {
    const site = selectedSite();
    if (!site) return;
    const button = $('#saveTelegramBtn');
    const message = $('#telegramStatusMessage');
    button.disabled = true;
    message.textContent = '';
    try {
      const data = await api(`/api/admin/sites/${site.id}/telegram`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ telegramChatId: $('#telegramChatId').value.trim() })
      });
      const index = sites.findIndex(item => item.id === data.site.id);
      if (index >= 0) sites[index] = data.site;
      message.textContent = data.site.telegram_chat_id ? '群组 ID 已保存' : 'Telegram 群组已取消';
      renderTelegramSettings();
    } catch (error) {
      message.textContent = error.message;
    } finally {
      button.disabled = false;
    }
  });

  $('#configureWebhookBtn').addEventListener('click', async () => {
    const button = $('#configureWebhookBtn');
    const message = $('#telegramStatusMessage');
    button.disabled = true;
    message.textContent = '';
    try {
      if (systemSettings.telegramWebhookActive) {
        await api('/api/admin/telegram/webhook', { method: 'DELETE' });
        message.textContent = 'Webhook 已停止，待处理消息已保留';
      } else {
        const data = await api('/api/admin/telegram/webhook', { method: 'POST' });
        message.textContent = data.botUsername ? `Webhook 已启用：@${data.botUsername}` : 'Webhook 已启用';
      }
    } catch (error) {
      message.textContent = error.message;
    } finally {
      await loadSystemSettings();
    }
  });

  async function loadConversations() {
    const data = await api('/api/admin/conversations');
    const receivedAt = Date.now();
    conversations = (data.conversations || []).map(conversation => ({
      ...conversation,
      _presence_received_at: receivedAt
    }));
    renderConversations();
    if (active) {
      const fresh = conversations.find(conversation => conversation.id === active.id);
      if (fresh) {
        active = fresh;
        renderProfile();
      }
    }
  }

  function applyPresenceUpdates(updates) {
    updates.forEach(update => {
      const conversation = conversations.find(item => item.id === update.conversation_id);
      if (!conversation) return;
      conversation.is_online = update.is_online;
      conversation.presence_checked_at = update.presence_checked_at;
      conversation.presence_age_seconds = update.presence_age_seconds;
      conversation._presence_received_at = Date.now();
      conversation.last_seen_at = update.last_seen_at;
    });
    const freshActive = active && conversations.find(item => item.id === active.id);
    if (freshActive) active = freshActive;
    renderConversations();
    if (active) {
      renderChatHeader(active);
      renderProfile();
    }
  }

  async function refreshPresenceSummary() {
    if (presenceSummaryInFlight || !token) return;
    presenceSummaryInFlight = true;
    try {
      const data = await api('/api/admin/presence');
      applyPresenceUpdates(data.presence || []);
    } catch {
      renderConversations();
      if (active) renderChatHeader(active);
    } finally {
      presenceSummaryInFlight = false;
    }
  }

  function startPresenceSummaryPolling() {
    if (presenceSummaryTimer) clearInterval(presenceSummaryTimer);
    presenceSummaryTimer = setInterval(refreshPresenceSummary, 30000);
  }

  async function refreshActivePresence() {
    if (!active?.crisp_session_id || !token) return;
    const conversationId = active.id;
    const requestId = ++activePresenceRequest;
    try {
      const data = await api(`/api/admin/conversations/${conversationId}/presence`);
      if (requestId !== activePresenceRequest || active?.id !== conversationId) return;
      applyPresenceUpdates([{ conversation_id: conversationId, ...data.presence }]);
    } catch {
      if (requestId === activePresenceRequest && active?.id === conversationId) {
        renderChatHeader(active);
        renderProfile();
      }
    }
  }

  function startActivePresencePolling() {
    stopActivePresencePolling();
    if (!active?.crisp_session_id) return;
    refreshActivePresence();
    activePresenceTimer = setInterval(refreshActivePresence, 15000);
  }

  function groupedConversations() {
    const groups = new Map();
    conversations.forEach(conversation => {
      const key = conversationSiteKey(conversation);
      if (!groups.has(key)) groups.set(key, { label: conversationSiteLabel(conversation), items: [] });
      groups.get(key).items.push(conversation);
    });
    return groups;
  }

  function renderSiteGroups() {
    const groups = groupedConversations();
    if (siteFilter !== 'all' && !groups.has(siteFilter)) siteFilter = 'all';
    const list = $('#siteGroupList');
    list.innerHTML = '';
    $('#siteGroupCount').textContent = `${groups.size} 个网站`;

    const appendOption = (key, label, items, mark) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = `site-group-button${siteFilter === key ? ' active' : ''}`;
      button.setAttribute('aria-pressed', siteFilter === key ? 'true' : 'false');
      button.title = label;

      const icon = document.createElement('span');
      icon.className = 'site-group-mark';
      icon.textContent = mark;
      const name = document.createElement('span');
      name.className = 'site-group-name';
      name.textContent = label;
      const stats = document.createElement('span');
      stats.className = 'site-group-stats';
      const unreadCount = items.reduce((total, conversation) => total + Number(conversation.unread_admin || 0), 0);
      if (unreadCount) {
        const unread = document.createElement('span');
        unread.className = 'site-group-unread';
        unread.title = `${unreadCount} 条未读`;
        stats.appendChild(unread);
      }
      const count = document.createElement('span');
      count.className = 'site-group-count';
      count.textContent = items.length;
      stats.appendChild(count);
      button.append(icon, name, stats);
      button.addEventListener('click', () => {
        siteFilter = key;
        renderConversations();
      });
      list.appendChild(button);
    };

    appendOption('all', '全部网站', conversations, '全');
    groups.forEach((group, key) => {
      appendOption(key, group.label, group.items, group.label.slice(0, 1).toUpperCase());
    });
  }

  function renderConversations() {
    renderSiteGroups();
    const query = $('#searchInput').value.trim().toLowerCase();
    const list = $('#conversationList');
    const groups = groupedConversations();
    const selectedGroup = siteFilter === 'all' ? null : groups.get(siteFilter);
    list.innerHTML = '';
    const visible = conversations.filter(conversation => {
      if (siteFilter !== 'all' && conversationSiteKey(conversation) !== siteFilter) return false;
      if (filter === 'unread' && !conversation.unread_admin) return false;
      if (filter === 'closed' && conversation.status !== 'closed') return false;
      const text = `${displayName(conversation)} ${conversation.email || ''} ${conversation.external_user_id || ''} ${conversation.last_message_preview || ''} ${conversation.site_url || ''} ${conversation.site_name || ''}`.toLowerCase();
      return !query || text.includes(query);
    });

    $('#siteLabel').textContent = selectedGroup ? selectedGroup.label : `${conversations.length} 个会话`;
    $('#conversationListTitle').textContent = selectedGroup ? selectedGroup.label : '全部会话';
    $('#conversationResultCount').textContent = visible.length;

    if (!visible.length) {
      const empty = document.createElement('div');
      empty.className = 'conversation-empty';
      empty.textContent = conversations.length ? '没有符合条件的会话' : '暂无会话';
      list.appendChild(empty);
      return;
    }

    if (siteFilter !== 'all') {
      visible.forEach(conversation => list.appendChild(renderConversationItem(conversation)));
      return;
    }

    const visibleGroups = new Map();
    visible.forEach(conversation => {
      const key = conversationSiteKey(conversation);
      if (!visibleGroups.has(key)) visibleGroups.set(key, { label: conversationSiteLabel(conversation), items: [] });
      visibleGroups.get(key).items.push(conversation);
    });
    visibleGroups.forEach((groupData, key) => {
      const collapsed = collapsedConversationGroups.has(key);
      const group = document.createElement('section');
      group.className = `conversation-group${collapsed ? ' collapsed' : ''}`;
      const heading = document.createElement('button');
      heading.type = 'button';
      heading.className = 'conversation-group-title';
      heading.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
      heading.title = collapsed ? '展开此网站的会话' : '收起此网站的会话';

      const labelWrap = document.createElement('span');
      labelWrap.className = 'conversation-group-label';
      const chevron = document.createElement('span');
      chevron.className = 'conversation-group-chevron';
      chevron.setAttribute('aria-hidden', 'true');
      const label = document.createElement('span');
      label.className = 'conversation-group-name';
      label.textContent = groupData.label;
      labelWrap.append(chevron, label);

      const stats = document.createElement('span');
      stats.className = 'conversation-group-stats';
      const unreadCount = groupData.items.reduce((total, conversation) => total + Number(conversation.unread_admin || 0), 0);
      if (unreadCount) {
        const unread = document.createElement('span');
        unread.className = 'conversation-group-unread-count';
        unread.textContent = unreadCount;
        unread.title = `${unreadCount} 条未读`;
        unread.setAttribute('aria-label', `${unreadCount} 条未读`);
        stats.appendChild(unread);
      }
      const count = document.createElement('small');
      count.textContent = groupData.items.length;
      count.title = `${groupData.items.length} 个会话`;
      stats.appendChild(count);
      heading.append(labelWrap, stats);
      heading.addEventListener('click', () => {
        if (collapsedConversationGroups.has(key)) collapsedConversationGroups.delete(key);
        else collapsedConversationGroups.add(key);
        saveCollapsedConversationGroups();
        renderConversations();
      });
      group.appendChild(heading);
      if (!collapsed) groupData.items.forEach(conversation => group.appendChild(renderConversationItem(conversation)));
      list.appendChild(group);
    });
  }

  function renderConversationItem(conversation) {
    const element = document.createElement('button');
    element.type = 'button';
    element.className = `conversation${active?.id === conversation.id ? ' active' : ''}`;
    element.setAttribute('aria-label', `${displayName(conversation)}，${conversation.last_message_preview || '新会话'}`);
    if (active?.id === conversation.id) element.setAttribute('aria-current', 'true');
    element.onclick = () => selectConversation(conversation);
    const avatar = document.createElement('div');
    avatar.className = 'conv-avatar';
    avatar.textContent = displayName(conversation).slice(0, 1).toUpperCase();
    const presenceState = conversationPresenceState(conversation);
    if (presenceState === 'online') {
      avatar.classList.add('online');
      avatar.title = '访客在线';
    }
    const main = document.createElement('div');
    main.className = 'conv-main';
    const top = document.createElement('div');
    top.className = 'conv-top';
    const name = document.createElement('div');
    name.className = 'conv-name';
    name.textContent = displayName(conversation);
    const time = document.createElement('div');
    time.className = 'conv-time';
    time.textContent = formatTime(conversation.last_message_at || conversation.created_at);
    top.append(name, time);
    const preview = document.createElement('div');
    preview.className = 'conv-preview';
    preview.textContent = conversation.last_message_preview || '新会话';
    main.append(top, preview);
    element.append(avatar, main);
    if (conversation.unread_admin) {
      const unread = document.createElement('div');
      unread.className = 'unread';
      unread.textContent = Math.min(conversation.unread_admin, 99);
      element.appendChild(unread);
    }
    return element;
  }

  function renderChatHeader(conversation) {
    const closed = conversation.status === 'closed';
    $('#chatName').textContent = displayName(conversation);
    $('#chatAvatar').textContent = displayName(conversation).slice(0, 1).toUpperCase();
    $('#chatStatus').textContent = closed ? '已关闭' : '会话进行中';
    $('#chatStatus').classList.toggle('closed', closed);
    const presence = $('#chatPresence');
    const presenceState = conversationPresenceState(conversation);
    presence.textContent = conversationPresenceLabel(conversation);
    presence.className = `chat-presence ${presenceState}`;
    $('#chatSite').textContent = conversationSiteLabel(conversation);
    $('#toggleStatusBtn').textContent = closed ? '重新打开' : '关闭会话';
  }

  async function selectConversation(conversation) {
    active = conversation;
    renderConversations();
    $('#emptyChat').classList.add('hidden');
    $('#chatView').classList.remove('hidden');
    renderChatHeader(conversation);
    renderProfile();
    startActivePresencePolling();
    if (socket) socket.emit('conversation:join', { conversationId: conversation.id });
    const data = await api(`/api/admin/conversations/${conversation.id}/messages`);
    renderMessages(data.messages || []);
    if (innerWidth <= 760) $('.inbox').classList.add('mobile-hidden');
  }

  function renderMessages(messages) {
    const box = $('#adminMessages');
    box.innerHTML = '';
    messages.forEach(renderMessage);
    box.scrollTop = box.scrollHeight;
  }

  function renderMessage(message) {
    const box = $('#adminMessages');
    if (box.querySelector(`[data-mid="${message.id}"]`)) return;
    const row = document.createElement('div');
    row.className = `admin-msg ${message.sender_type}`;
    row.dataset.mid = message.id;
    const bubble = document.createElement('div');
    bubble.className = 'admin-bubble';
    if (message.message_type === 'image' && message.file_url) {
      const link = document.createElement('a');
      link.href = message.file_url;
      link.target = '_blank';
      link.rel = 'noopener';
      const image = document.createElement('img');
      image.className = 'admin-image';
      image.src = message.file_url;
      image.alt = message.file_name || '图片';
      link.appendChild(image);
      bubble.appendChild(link);
    } else if (message.message_type === 'file' && message.file_url) {
      const link = document.createElement('a');
      link.href = message.file_url;
      link.target = '_blank';
      link.rel = 'noopener';
      link.className = 'admin-file';
      link.textContent = `📎 ${message.file_name || '文件'}`;
      bubble.appendChild(link);
    } else {
      const text = document.createElement('div');
      text.textContent = message.content || '';
      bubble.appendChild(text);
    }
    if (message.message_type !== 'text' && message.content) {
      const caption = document.createElement('div');
      caption.className = 'attachment-caption';
      caption.textContent = message.content;
      bubble.appendChild(caption);
    }
    const time = document.createElement('div');
    time.className = 'admin-time';
    time.textContent = formatTime(message.created_at);
    bubble.appendChild(time);
    row.appendChild(bubble);
    box.appendChild(row);
  }

  function parsedMetadata(value) {
    if (!value) return null;
    if (typeof value === 'object') return value;
    try { return JSON.parse(value); } catch { return null; }
  }

  function profileExternalUserId(conversation) {
    const value = String(conversation.external_user_id || '').trim();
    if (!value || value === conversation.crisp_session_id || value.startsWith('session_')) return '';
    return value;
  }

  function profileDeviceName(value) {
    if (!value || typeof value !== 'object') return null;
    return [value.name, value.version].filter(Boolean).join(' ') || null;
  }

  function profileClientName(os, userAgent) {
    const source = `${os?.name || ''} ${userAgent || ''}`;
    if (/iphone|ipad|ipod|\bios\b/i.test(source)) return 'iOS';
    if (/android/i.test(source)) return 'Android';
    if (/windows/i.test(source)) return 'Windows';
    if (/cros|chrome\s?os/i.test(source)) return 'ChromeOS';
    if (/macintosh|mac\s?os|mac os x|\bos x\b/i.test(source)) return 'MacOS';
    if (/linux/i.test(source)) return 'Linux';
    return os?.name || '未知';
  }

  function profileIpAddress(value) {
    const candidate = String(value || '').trim();
    if (!candidate) return 'Crisp 未提供';
    const ipv4 = /^(?:\d{1,3}\.){3}\d{1,3}$/.test(candidate);
    const ipv6 = candidate.includes(':') && /^[0-9a-f:]+$/i.test(candidate);
    return ipv4 || ipv6 ? candidate : 'Crisp 已隐藏';
  }

  function renderProfile() {
    const panel = $('#visitorPanel');
    if (!active) {
      panel.innerHTML = '<div class="profile-empty">选择会话后显示访客资料</div>';
      return;
    }
    panel.innerHTML = '';
    const wrap = document.createElement('div');
    wrap.className = 'profile';
    const avatar = document.createElement('div');
    avatar.className = 'profile-avatar';
    avatar.textContent = displayName(active).slice(0, 1).toUpperCase();
    const heading = document.createElement('h3');
    heading.textContent = displayName(active);
    const email = document.createElement('div');
    email.className = 'email';
    const externalUserId = profileExternalUserId(active);
    const signedIn = Boolean(active.identity_verified || active.email || externalUserId);
    email.textContent = active.email || '未登录访客';
    const conversationStatus = document.createElement('div');
    conversationStatus.className = 'status-chip';
    conversationStatus.style.marginTop = '10px';
    conversationStatus.textContent = active.status === 'closed' ? '已关闭' : 'Open';
    const identityStatus = document.createElement('div');
    identityStatus.className = `status-chip identity-status${active.identity_verified ? ' verified' : ''}`;
    identityStatus.textContent = active.identity_verified
      ? `${signedIn ? '已登录用户' : '未登录访客'} · Crisp 已验证`
      : (signedIn ? '已登录用户' : '未登录访客');
    const presenceState = conversationPresenceState(active);
    const presenceStatus = document.createElement('div');
    presenceStatus.className = `status-chip presence-status ${presenceState}`;
    presenceStatus.textContent = conversationPresenceLabel(active);
    const metadata = parsedMetadata(active.metadata_json);
    const context = parsedMetadata(active.context_json) || {};
    const location = context.location && typeof context.location === 'object'
      ? [...new Set([context.location.country, context.location.region, context.location.city].filter(Boolean))].join(' ')
      : '';
    const pages = Array.isArray(context.pages)
      ? context.pages.map(page => page?.url).filter(value => /^https?:\/\//i.test(value || '')).slice(0, 10)
      : [];
    const details = [
      ['网站', active.site_name],
      ['网站地址', active.site_url],
      ['访客类型', signedIn ? '已登录用户' : '未登录访客'],
      ['在线状态', conversationPresenceLabel(active)],
      ['用户', active.display_name || externalUserId || String(active.visitor_key || '').replace(/^crisp:/, '')],
      ...(active.email ? [['邮箱', active.email]] : []),
      ...(externalUserId && externalUserId !== active.display_name ? [['用户 ID', externalUserId]] : []),
      ['地理位置', location],
      ['操作系统', profileDeviceName(context.os)],
      ['浏览器', profileDeviceName(context.browser)],
      ['附加信息', JSON.stringify(metadata || {}, null, 2)],
      ['访问历史', pages.length ? pages.join('\n') : '暂无'],
      ['当前页面', active.current_title || active.current_url],
      ['Crisp 会话 ID', active.crisp_session_id],
      ['公网 IP', profileIpAddress(active.ip_address)],
      ['客户端', profileClientName(context.os, active.user_agent)],
      ['最后活动', active.last_seen_at ? new Date(active.last_seen_at).toLocaleString() : '-']
    ];
    const detail = document.createElement('div');
    detail.className = 'detail';
    details.forEach(([labelText, value]) => {
      const row = document.createElement('div');
      row.className = 'detail-row';
      const label = document.createElement('label');
      label.textContent = labelText;
      const data = document.createElement('div');
      if (labelText === '访问历史' && pages.length) {
        pages.forEach(url => {
          const link = document.createElement('a');
          link.href = url;
          link.target = '_blank';
          link.rel = 'noopener';
          link.textContent = url;
          data.appendChild(link);
        });
      } else {
        data.textContent = value || '-';
      }
      row.append(label, data);
      detail.appendChild(row);
    });
    wrap.append(avatar, heading, email, conversationStatus, presenceStatus, identityStatus, detail);
    panel.appendChild(wrap);
  }

  $('#adminComposer').addEventListener('submit', async event => {
    event.preventDefault();
    const content = $('#adminInput').value.trim();
    if (!content || !active) return;
    $('#adminInput').value = '';
    try {
      await api(`/api/admin/conversations/${active.id}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content })
      });
    } catch (error) {
      $('#adminInput').value = content;
      alert(error.message);
    }
  });

  $('#adminInput').addEventListener('keydown', event => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      $('#adminComposer').requestSubmit();
    }
  });

  $('#adminFile').addEventListener('change', async event => {
    const file = event.target.files?.[0];
    if (!file || !active) return;
    const form = new FormData();
    form.append('file', file);
    try {
      await api(`/api/admin/conversations/${active.id}/upload`, { method: 'POST', body: form });
    } catch (error) {
      alert(error.message);
    }
    event.target.value = '';
  });

  $('#toggleStatusBtn').addEventListener('click', async () => {
    if (!active) return;
    const status = active.status === 'closed' ? 'open' : 'closed';
    await api(`/api/admin/conversations/${active.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status })
    });
    active.status = status;
    renderChatHeader(active);
    renderProfile();
    loadConversations();
  });

  const conversationSearchInput = $('#searchInput');
  conversationSearchInput.addEventListener('pointerdown', unlockConversationSearch);
  conversationSearchInput.addEventListener('keydown', unlockConversationSearch);
  conversationSearchInput.addEventListener('paste', unlockConversationSearch);
  conversationSearchInput.addEventListener('drop', unlockConversationSearch);
  conversationSearchInput.addEventListener('input', renderConversations);
  document.querySelectorAll('.tab').forEach(button => button.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(item => {
      item.classList.remove('active');
      item.setAttribute('aria-selected', 'false');
    });
    button.classList.add('active');
    button.setAttribute('aria-selected', 'true');
    filter = button.dataset.filter;
    renderConversations();
  }));

  function connectSocket() {
    socket = io({ auth: { token } });
    socket.on('conversation:updated', conversation => {
      conversation._presence_received_at = Date.now();
      const index = conversations.findIndex(item => item.id === conversation.id);
      if (index >= 0) conversations[index] = conversation;
      else conversations.unshift(conversation);
      conversations.sort((left, right) => new Date(right.last_message_at || right.created_at) - new Date(left.last_message_at || left.created_at));
      if (active?.id === conversation.id) {
        active = conversation;
        renderChatHeader(active);
      }
      renderConversations();
      renderProfile();
    });
    socket.on('message:new', message => {
      if (active?.id === message.conversation_id) {
        renderMessage(message);
        const box = $('#adminMessages');
        box.scrollTop = box.scrollHeight;
      }
    });
  }

  $('#mobileInboxBackBtn').addEventListener('click', () => {
    $('.inbox').classList.remove('mobile-hidden');
    stopActivePresencePolling();
  });

  if (token) loginReady();
})();
