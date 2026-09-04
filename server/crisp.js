const crypto = require('crypto');
const net = require('net');
const path = require('path');

function createCrispBridge(options) {
  const {
    pool,
    apiBase = 'https://api.crisp.chat/v1',
    createMessage,
    afterVisitorMessage,
    encrypt,
    decrypt,
    getPublicBaseUrl
  } = options;
  const crispBase = apiBase.replace(/\/$/, '');
  let processing = false;
  let workerTimer = null;
  let lastFingerprint = 0;
  let recentPresenceRefresh = null;
  let recentPresenceCache = { updatedAt: 0, result: null };

  function text(value, max = 4000) {
    return String(value || '').trim().slice(0, max);
  }

  function visitorNetwork(details) {
    const meta = details?.meta && typeof details.meta === 'object' ? details.meta : {};
    const device = meta.device && typeof meta.device === 'object' ? meta.device : {};
    const system = device.system && typeof device.system === 'object' ? device.system : {};
    const connection = meta.connection && typeof meta.connection === 'object' ? meta.connection : {};
    const candidates = [meta.ip, details?.ip, device.ip, connection.ip];
    let ipAddress = '';
    for (const value of candidates) {
      for (const part of String(value || '').split(',')) {
        const candidate = part.trim().replace(/^\[|\]$/g, '');
        if (net.isIP(candidate)) {
          ipAddress = candidate;
          break;
        }
      }
      if (ipAddress) break;
    }
    return { meta, device, system, ipAddress, userAgent: text(system.useragent, 1000) };
  }

  function presenceSnapshot(details) {
    const availability = text(details?.availability, 16).toLowerCase();
    let isOnline = null;
    if (availability === 'online') isOnline = 1;
    else if (availability === 'offline') isOnline = 0;
    else if (typeof details?.active?.now === 'boolean') isOnline = details.active.now ? 1 : 0;

    const rawLast = Number(details?.active?.last);
    const timestamp = Number.isFinite(rawLast) && rawLast > 0
      ? (rawLast < 1e12 ? rawLast * 1000 : rawLast)
      : 0;
    const lastSeenAt = timestamp ? new Date(timestamp) : null;
    return {
      isOnline,
      lastSeenAt: lastSeenAt && !Number.isNaN(lastSeenAt.getTime()) ? lastSeenAt : null
    };
  }

  async function updateVisitorPresence(visitorId, details) {
    const presence = presenceSnapshot(details);
    const network = visitorNetwork(details);
    await pool.execute(`
      UPDATE visitors
      SET user_agent=COALESCE(NULLIF(?,''),user_agent),
          ip_address=COALESCE(NULLIF(?,''),ip_address),
          is_online=?, presence_checked_at=NOW(),
          last_seen_at=CASE
            WHEN ? IS NULL THEN last_seen_at
            WHEN last_seen_at IS NULL OR last_seen_at<? THEN ?
            ELSE last_seen_at
          END
      WHERE id=?`, [
      network.userAgent,
      network.ipAddress,
      presence.isOnline,
      presence.lastSeenAt,
      presence.lastSeenAt,
      presence.lastSeenAt,
      visitorId
    ]);
    const [rows] = await pool.execute(`
      SELECT is_online, presence_checked_at, last_seen_at,
             TIMESTAMPDIFF(SECOND,presence_checked_at,NOW()) AS presence_age_seconds
      FROM visitors WHERE id=? LIMIT 1`, [visitorId]);
    return rows[0] || {
      is_online: null,
      presence_checked_at: null,
      last_seen_at: null,
      presence_age_seconds: null
    };
  }

  async function ensureColumn(table, column, definition) {
    const [rows] = await pool.execute(
      `SELECT 1 FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? AND COLUMN_NAME=? LIMIT 1`,
      [table, column]
    );
    if (!rows.length) await pool.query(`ALTER TABLE \`${table}\` ADD COLUMN \`${column}\` ${definition}`);
  }

  async function ensureIndex(table, index, definition) {
    const [rows] = await pool.execute(
      `SELECT 1 FROM information_schema.STATISTICS
       WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? AND INDEX_NAME=? LIMIT 1`,
      [table, index]
    );
    if (!rows.length) await pool.query(`ALTER TABLE \`${table}\` ADD ${definition}`);
  }

  async function ensureSchema() {
    await ensureColumn('sites', 'integration_mode', "ENUM('native','crisp') NOT NULL DEFAULT 'native' AFTER telegram_chat_id");
    await ensureColumn('sites', 'crisp_website_id', 'VARCHAR(64) NULL AFTER integration_mode');
    await ensureColumn('sites', 'crisp_token_identifier', 'TEXT NULL AFTER crisp_website_id');
    await ensureColumn('sites', 'crisp_token_key', 'TEXT NULL AFTER crisp_token_identifier');
    await ensureColumn('sites', 'crisp_webhook_secret', 'TEXT NULL AFTER crisp_token_key');
    await ensureColumn('conversations', 'crisp_session_id', 'VARCHAR(128) NULL AFTER telegram_thread_id');
    await ensureColumn('messages', 'crisp_fingerprint', 'BIGINT NULL AFTER file_size');
    await ensureColumn('visitors', 'context_json', 'JSON NULL AFTER metadata_json');
    await ensureColumn('visitors', 'is_online', 'TINYINT(1) NULL DEFAULT NULL AFTER last_seen_at');
    await ensureColumn('visitors', 'presence_checked_at', 'TIMESTAMP NULL AFTER is_online');
    await ensureIndex(
      'conversations',
      'uk_conversations_site_crisp_session',
      'UNIQUE KEY `uk_conversations_site_crisp_session` (`site_id`,`crisp_session_id`)'
    );
    await ensureIndex(
      'messages',
      'uk_messages_conversation_crisp_fingerprint',
      'UNIQUE KEY `uk_messages_conversation_crisp_fingerprint` (`conversation_id`,`crisp_fingerprint`)'
    );
    await pool.query(`
      CREATE TABLE IF NOT EXISTS crisp_outbox (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        message_id BIGINT UNSIGNED NOT NULL,
        status ENUM('pending','processing','sent','failed') NOT NULL DEFAULT 'pending',
        attempts INT UNSIGNED NOT NULL DEFAULT 0,
        next_attempt_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        last_error VARCHAR(1000) NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        UNIQUE KEY uk_crisp_outbox_message (message_id),
        KEY idx_crisp_outbox_pending (status, next_attempt_at),
        CONSTRAINT fk_crisp_outbox_message FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    await pool.query("UPDATE sites SET integration_mode='crisp' WHERE integration_mode<>'crisp'");
    await pool.query("UPDATE crisp_outbox SET status='pending' WHERE status='processing'");
  }

  async function siteRowById(siteId) {
    const [rows] = await pool.execute(`
      SELECT id, site_key, integration_mode, crisp_website_id,
             crisp_token_identifier, crisp_token_key, crisp_webhook_secret
      FROM sites WHERE id=? LIMIT 1`, [siteId]);
    return rows[0] || null;
  }

  async function siteRowByKey(siteKey) {
    const [rows] = await pool.execute(`
      SELECT id, site_key, integration_mode, crisp_website_id,
             crisp_token_identifier, crisp_token_key, crisp_webhook_secret
      FROM sites WHERE site_key=? LIMIT 1`, [siteKey]);
    return rows[0] || null;
  }

  async function decodedConfig(row, { tolerateUnreadable = false } = {}) {
    if (!row) return null;
    const encryptedFields = {
      tokenIdentifier: row.crisp_token_identifier || '',
      tokenKey: row.crisp_token_key || '',
      webhookSecret: row.crisp_webhook_secret || ''
    };
    const decoded = {};
    const unreadableFields = [];
    for (const [field, value] of Object.entries(encryptedFields)) {
      try {
        decoded[field] = await decrypt(value);
      } catch (error) {
        if (!tolerateUnreadable || error.code !== 'SETTINGS_DECRYPT_FAILED') throw error;
        decoded[field] = '';
        unreadableFields.push(field);
      }
    }
    return {
      siteId: row.id,
      siteKey: row.site_key,
      enabled: row.integration_mode === 'crisp',
      websiteId: row.crisp_website_id || '',
      ...decoded,
      unreadableFields
    };
  }

  async function publicConfig(siteId) {
    const config = await decodedConfig(await siteRowById(siteId), { tolerateUnreadable: true });
    if (!config) return null;
    const baseUrl = String(await getPublicBaseUrl() || '').replace(/\/$/, '');
    const webhookUrl = baseUrl && config.webhookSecret
      ? `${baseUrl}/api/crisp/webhook/${encodeURIComponent(config.siteKey)}?key=${encodeURIComponent(config.webhookSecret)}`
      : '';
    return {
      enabled: config.enabled,
      websiteId: config.websiteId,
      tokenIdentifierConfigured: Boolean(config.tokenIdentifier),
      tokenIdentifierHint: config.tokenIdentifier ? `••••${config.tokenIdentifier.slice(-6)}` : '',
      tokenKeyConfigured: Boolean(config.tokenKey),
      webhookSecretConfigured: Boolean(config.webhookSecret),
      webhookUrl,
      recoveryRequired: config.unreadableFields.length > 0
    };
  }

  async function secretValue(siteId, field) {
    let config;
    try {
      config = await decodedConfig(await siteRowById(siteId));
    } catch (error) {
      if (error.code === 'SETTINGS_DECRYPT_FAILED') {
        const recoveryError = new Error('Crisp 凭证无法解密，请重新填写 Website Token ID 和 Website Token Key');
        recoveryError.code = error.code;
        throw recoveryError;
      }
      throw error;
    }
    if (!config) return null;
    const values = {
      tokenIdentifier: config.tokenIdentifier,
      tokenKey: config.tokenKey
    };
    if (!Object.hasOwn(values, field)) throw new Error('Crisp 凭证字段无效');
    return { value: values[field] || '' };
  }

  async function saveConfig(siteId, values) {
    const row = await siteRowById(siteId);
    if (!row) return null;
    const current = await decodedConfig(row, { tolerateUnreadable: true });
    const websiteId = Object.hasOwn(values, 'websiteId') ? text(values.websiteId, 64) : current.websiteId;
    const suppliedIdentifier = text(values.tokenIdentifier, 512);
    const suppliedKey = text(values.tokenKey, 1024);
    const tokenIdentifier = suppliedIdentifier || current.tokenIdentifier;
    const tokenKey = suppliedKey || current.tokenKey;
    const enabled = Object.hasOwn(values, 'enabled') ? values.enabled === true : current.enabled;
    let webhookSecret = current.webhookSecret;

    if (current.unreadableFields.some(field => field === 'tokenIdentifier' || field === 'tokenKey')
        && (!suppliedIdentifier || !suppliedKey)) {
      throw new Error('检测到旧加密凭证无法读取，请重新填写 Website Token ID 和 Website Token Key');
    }

    if (websiteId && !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(websiteId)) {
      throw new Error('Crisp Website ID 格式无效');
    }
    if (tokenIdentifier && /\s/.test(tokenIdentifier)) throw new Error('Crisp Token ID 不能包含空格');
    if (tokenKey && /\s/.test(tokenKey)) throw new Error('Crisp Token Key 不能包含空格');
    if (suppliedIdentifier && suppliedIdentifier.length < 8) throw new Error('Crisp Token ID 格式无效');
    if (suppliedKey && suppliedKey.length < 16) throw new Error('Crisp Token Key 格式无效');
    if (!webhookSecret || current.unreadableFields.includes('webhookSecret') || values.regenerateWebhookSecret === true) {
      webhookSecret = crypto.randomBytes(32).toString('base64url');
    }
    if (enabled && (!websiteId || !tokenIdentifier || !tokenKey)) {
      throw new Error('启用 Crisp 托管前请填写 Website ID、Token ID 和 Token Key');
    }

    await pool.execute(`
      UPDATE sites
      SET integration_mode=?, crisp_website_id=?, crisp_token_identifier=?, crisp_token_key=?, crisp_webhook_secret=?
      WHERE id=?`, [
      enabled ? 'crisp' : 'native',
      websiteId || null,
      tokenIdentifier ? await encrypt(tokenIdentifier) : null,
      tokenKey ? await encrypt(tokenKey) : null,
      await encrypt(webhookSecret),
      siteId
    ]);

    if (current.websiteId && current.websiteId !== websiteId) {
      await pool.execute('UPDATE conversations SET crisp_session_id=NULL WHERE site_id=?', [siteId]);
    }
    await pool.execute(`
      UPDATE crisp_outbox o
      JOIN messages m ON m.id=o.message_id
      JOIN conversations c ON c.id=m.conversation_id
      SET o.status='pending', o.next_attempt_at=NOW(), o.last_error=NULL
      WHERE c.site_id=? AND o.status='failed' AND o.attempts<20`, [siteId]);
    processOutbox().catch(error => console.error('Crisp outbox:', error));
    return publicConfig(siteId);
  }

  async function call(config, method, resource, body) {
    if (!config.websiteId || !config.tokenIdentifier || !config.tokenKey) {
      throw new Error('Crisp 托管配置不完整');
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    try {
      const response = await fetch(`${crispBase}${resource}`, {
        method,
        headers: {
          Authorization: `Basic ${Buffer.from(`${config.tokenIdentifier}:${config.tokenKey}`).toString('base64')}`,
          'X-Crisp-Tier': 'website',
          ...(body ? { 'Content-Type': 'application/json' } : {})
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok || result.error === true) {
        throw new Error(result.reason || `Crisp API 请求失败 (${response.status})`);
      }
      return Object.hasOwn(result, 'data') ? result.data : result;
    } catch (error) {
      if (error.name === 'AbortError') throw new Error('Crisp API 请求超时');
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  async function testConnection(siteId) {
    const config = await decodedConfig(await siteRowById(siteId));
    if (!config) throw new Error('网站不存在');
    const website = await call(config, 'GET', `/website/${encodeURIComponent(config.websiteId)}`);
    return { websiteName: website.name || website.website?.name || '' };
  }

  function generateFingerprint() {
    const candidate = Date.now() * 1000;
    lastFingerprint = Math.max(candidate, lastFingerprint + 1);
    return lastFingerprint;
  }

  async function enqueueMessage(messageId) {
    const [rows] = await pool.execute(`
      SELECT m.id, m.crisp_fingerprint
      FROM messages m
      JOIN conversations c ON c.id=m.conversation_id
      JOIN sites s ON s.id=c.site_id
      WHERE m.id=? AND m.sender_type='agent' AND s.integration_mode='crisp'
        AND c.crisp_session_id IS NOT NULL AND c.crisp_session_id<>''
      LIMIT 1`, [messageId]);
    if (!rows.length) return;
    const fingerprint = Number(rows[0].crisp_fingerprint) || generateFingerprint();
    await pool.execute('UPDATE messages SET crisp_fingerprint=? WHERE id=? AND crisp_fingerprint IS NULL', [fingerprint, messageId]);
    await pool.execute('INSERT IGNORE INTO crisp_outbox(message_id) VALUES(?)', [messageId]);
    processOutbox().catch(error => console.error('Crisp outbox:', error));
  }

  function mimeType(fileName, image) {
    const extension = path.extname(String(fileName || '')).toLowerCase();
    const known = {
      '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
      '.webp': 'image/webp', '.pdf': 'application/pdf', '.zip': 'application/zip', '.txt': 'text/plain'
    };
    return known[extension] || (image ? 'image/jpeg' : 'application/octet-stream');
  }

  async function forwardMessage(messageId) {
    const [rows] = await pool.execute(`
      SELECT m.*, c.crisp_session_id, s.id AS site_id, s.site_key, s.integration_mode,
             s.crisp_website_id, s.crisp_token_identifier, s.crisp_token_key, s.crisp_webhook_secret
      FROM messages m
      JOIN conversations c ON c.id=m.conversation_id
      JOIN sites s ON s.id=c.site_id
      WHERE m.id=? LIMIT 1`, [messageId]);
    const message = rows[0];
    if (!message || message.integration_mode !== 'crisp' || !message.crisp_session_id) return;
    const config = await decodedConfig({
      id: message.site_id,
      site_key: message.site_key,
      integration_mode: message.integration_mode,
      crisp_website_id: message.crisp_website_id,
      crisp_token_identifier: message.crisp_token_identifier,
      crisp_token_key: message.crisp_token_key,
      crisp_webhook_secret: message.crisp_webhook_secret
    });
    const payload = {
      type: message.message_type === 'text' ? 'text' : 'file',
      from: 'operator',
      origin: 'chat',
      content: message.message_type === 'text' ? message.content : {
        name: message.file_name || (message.message_type === 'image' ? 'image' : 'file'),
        url: message.file_url,
        type: mimeType(message.file_name, message.message_type === 'image')
      },
      fingerprint: Number(message.crisp_fingerprint)
    };
    await call(
      config,
      'POST',
      `/website/${encodeURIComponent(config.websiteId)}/conversation/${encodeURIComponent(message.crisp_session_id)}/message`,
      payload
    );
  }

  async function processOutbox() {
    if (processing) return;
    processing = true;
    try {
      const [items] = await pool.execute(`
        SELECT id, message_id, attempts FROM crisp_outbox
        WHERE status IN ('pending','failed') AND attempts<20 AND next_attempt_at<=NOW()
        ORDER BY id ASC LIMIT 10`);
      for (const item of items) {
        const [claimed] = await pool.execute(
          "UPDATE crisp_outbox SET status='processing' WHERE id=? AND status IN ('pending','failed')",
          [item.id]
        );
        if (!claimed.affectedRows) continue;
        try {
          await forwardMessage(item.message_id);
          await pool.execute("UPDATE crisp_outbox SET status='sent', last_error=NULL WHERE id=?", [item.id]);
        } catch (error) {
          const attempts = item.attempts + 1;
          const nextAttempt = new Date(Date.now() + Math.min(300, 2 ** Math.min(attempts, 8)) * 1000);
          await pool.execute(
            "UPDATE crisp_outbox SET status='failed', attempts=?, next_attempt_at=?, last_error=? WHERE id=?",
            [attempts, nextAttempt, String(error.message || error).slice(0, 1000), item.id]
          );
        }
      }
    } finally {
      processing = false;
    }
  }

  function startWorker() {
    if (workerTimer) return;
    workerTimer = setInterval(() => processOutbox().catch(error => console.error('Crisp outbox:', error)), 2500);
    workerTimer.unref();
    processOutbox().catch(error => console.error('Crisp outbox:', error));
  }

  function secureEqual(actualValue, expectedValue) {
    if (!actualValue || !expectedValue) return false;
    const actual = Buffer.from(String(actualValue));
    const expected = Buffer.from(String(expectedValue));
    return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
  }

  async function ensureConversation(site, data, visitorMessage) {
    const sessionId = text(data.session_id, 128);
    if (!/^session_[A-Za-z0-9_-]{8,120}$/.test(sessionId)) throw new Error('Crisp Session ID 格式无效');
    const nickname = visitorMessage ? text(data.user?.nickname, 120) : '';
    const suppliedUserId = visitorMessage ? text(data.user?.user_id, 191) : '';
    const externalUserId = suppliedUserId && suppliedUserId !== sessionId && !suppliedUserId.startsWith('session_')
      ? suppliedUserId
      : '';
    const visitorKey = `crisp:${sessionId}`;
    await pool.execute(`
      INSERT INTO visitors(site_id,visitor_key,display_name,external_user_id,identity_verified,last_seen_at)
      VALUES(?,?,?,?,0,NOW())
      ON DUPLICATE KEY UPDATE
        display_name=COALESCE(display_name,NULLIF(VALUES(display_name),'')),
        external_user_id=COALESCE(external_user_id,NULLIF(VALUES(external_user_id),'')),
        last_seen_at=NOW()`, [site.id, visitorKey, nickname || null, externalUserId || null]);
    const [visitorRows] = await pool.execute(
      'SELECT id FROM visitors WHERE site_id=? AND visitor_key=? LIMIT 1',
      [site.id, visitorKey]
    );
    const [created] = await pool.execute(`
      INSERT INTO conversations(site_id,visitor_id,status,last_message_at,crisp_session_id)
      VALUES(?,?,'open',NOW(),?)
      ON DUPLICATE KEY UPDATE id=LAST_INSERT_ID(id),status='open'`,
    [site.id, visitorRows[0].id, sessionId]);
    return { id: created.insertId, sessionId, visitorId: visitorRows[0].id };
  }

  async function enrichConversation(config, conversation) {
    const details = await call(
      config,
      'GET',
      `/website/${encodeURIComponent(config.websiteId)}/conversation/${encodeURIComponent(conversation.sessionId)}`
    );
    const network = visitorNetwork(details);
    const { meta, device, system } = network;
    const presence = presenceSnapshot(details);
    const geolocation = device.geolocation && typeof device.geolocation === 'object' ? device.geolocation : {};
    const region = geolocation.region && typeof geolocation.region === 'object'
      ? geolocation.region.name || geolocation.region.code || ''
      : geolocation.region;
    let metadata = null;
    if (meta.data && typeof meta.data === 'object' && !Array.isArray(meta.data)) {
      const serialized = JSON.stringify(meta.data);
      if (serialized.length <= 4000) metadata = serialized;
    }
    let pages = [];
    let pagesLoaded = false;
    try {
      const result = await call(
        config,
        'GET',
        `/website/${encodeURIComponent(config.websiteId)}/conversation/${encodeURIComponent(conversation.sessionId)}/pages/1`
      );
      if (Array.isArray(result)) {
        pagesLoaded = true;
        const seen = new Set();
        pages = result.reduce((items, page) => {
          const url = text(page?.page_url, 1000);
          if (items.length >= 10 || !/^https?:\/\//i.test(url) || seen.has(url)) return items;
          seen.add(url);
          items.push({
            url,
            title: text(page?.page_title, 500),
            timestamp: Number.isSafeInteger(Number(page?.timestamp)) ? Number(page.timestamp) : null
          });
          return items;
        }, []);
      }
    } catch (error) {
      console.error('Crisp page history sync:', error.message || error);
    }
    if (!pagesLoaded) {
      const [rows] = await pool.execute('SELECT context_json FROM visitors WHERE id=? LIMIT 1', [conversation.visitorId]);
      let existingContext = rows[0]?.context_json;
      if (typeof existingContext === 'string') {
        try { existingContext = JSON.parse(existingContext); } catch { existingContext = null; }
      }
      if (Array.isArray(existingContext?.pages)) pages = existingContext.pages.slice(0, 10);
    }
    const os = system.os && typeof system.os === 'object' ? system.os : {};
    const browser = system.browser && typeof system.browser === 'object' ? system.browser : {};
    const context = {
      location: {
        country: text(geolocation.country, 120),
        region: text(region, 120),
        city: text(geolocation.city, 120)
      },
      os: { name: text(os.name, 120), version: text(os.version, 64) },
      browser: { name: text(browser.name, 120), version: text(browser.version, 64) },
      pages
    };
    const latestPage = pages[0] || {};
    await pool.execute(`
      UPDATE visitors
      SET display_name=COALESCE(NULLIF(?,''),display_name),
          email=COALESCE(NULLIF(?,''),email),
          identity_verified=?, metadata_json=?, context_json=?,
          current_url=COALESCE(NULLIF(?,''),current_url),
          current_title=COALESCE(NULLIF(?,''),current_title),
          user_agent=COALESCE(NULLIF(?,''),user_agent),
          ip_address=COALESCE(NULLIF(?,''),ip_address), last_seen_at=NOW(),
          is_online=?, presence_checked_at=NOW()
      WHERE id=?`, [
      text(meta.nickname, 120), text(meta.email, 190), details.is_verified ? 1 : 0,
      metadata, JSON.stringify(context), text(latestPage.url, 1000), text(latestPage.title, 500),
      network.userAgent, network.ipAddress, presence.isOnline, conversation.visitorId
    ]);
  }

  async function refreshPresence(conversationId) {
    const [rows] = await pool.execute(`
      SELECT c.id, c.crisp_session_id, v.id AS visitor_id,
             s.id AS site_id, s.site_key, s.integration_mode, s.crisp_website_id,
             s.crisp_token_identifier, s.crisp_token_key, s.crisp_webhook_secret
      FROM conversations c
      JOIN visitors v ON v.id=c.visitor_id
      JOIN sites s ON s.id=c.site_id
      WHERE c.id=? LIMIT 1`, [conversationId]);
    const row = rows[0];
    if (!row) {
      const error = new Error('会话不存在');
      error.statusCode = 404;
      throw error;
    }
    if (row.integration_mode !== 'crisp' || !row.crisp_session_id) {
      const error = new Error('该会话没有 Crisp 在线状态');
      error.statusCode = 409;
      throw error;
    }
    const config = await decodedConfig({
      id: row.site_id,
      site_key: row.site_key,
      integration_mode: row.integration_mode,
      crisp_website_id: row.crisp_website_id,
      crisp_token_identifier: row.crisp_token_identifier,
      crisp_token_key: row.crisp_token_key,
      crisp_webhook_secret: row.crisp_webhook_secret
    });
    const details = await call(
      config,
      'GET',
      `/website/${encodeURIComponent(config.websiteId)}/conversation/${encodeURIComponent(row.crisp_session_id)}`
    );
    return updateVisitorPresence(row.visitor_id, details);
  }

  async function refreshRecentPresence() {
    if (recentPresenceCache.result && Date.now() - recentPresenceCache.updatedAt < 10000) {
      return recentPresenceCache.result;
    }
    if (recentPresenceRefresh) return recentPresenceRefresh;
    recentPresenceRefresh = (async () => {
      const [siteRows] = await pool.execute(`
        SELECT id, site_key, integration_mode, crisp_website_id,
               crisp_token_identifier, crisp_token_key, crisp_webhook_secret
        FROM sites
        WHERE integration_mode='crisp' AND crisp_website_id IS NOT NULL
          AND crisp_token_identifier IS NOT NULL AND crisp_token_key IS NOT NULL
        ORDER BY id ASC`);
      let refreshedSites = 0;
      let failedSites = 0;
      for (const site of siteRows) {
        try {
          const config = await decodedConfig(site);
          const details = await call(
            config,
            'GET',
            `/website/${encodeURIComponent(config.websiteId)}/conversations/1?per_page=50&include_empty=1`
          );
          if (Array.isArray(details)) {
            for (const item of details) {
              const sessionId = text(item?.session_id, 128);
              if (!sessionId) continue;
              const [visitors] = await pool.execute(
                'SELECT id FROM visitors WHERE site_id=? AND visitor_key=? LIMIT 1',
                [site.id, `crisp:${sessionId}`]
              );
              if (visitors[0]) await updateVisitorPresence(visitors[0].id, item);
            }
          }
          refreshedSites += 1;
        } catch (error) {
          failedSites += 1;
          console.error(`Crisp presence sync (${site.site_key}):`, error.message || error);
        }
      }
      const [presence] = await pool.execute(`
        SELECT c.id AS conversation_id, v.is_online, v.presence_checked_at, v.last_seen_at,
               TIMESTAMPDIFF(SECOND,v.presence_checked_at,NOW()) AS presence_age_seconds
        FROM conversations c
        JOIN visitors v ON v.id=c.visitor_id
        WHERE c.crisp_session_id IS NOT NULL
        ORDER BY COALESCE(c.last_message_at,c.created_at) DESC
        LIMIT 300`);
      const result = { presence, refreshedSites, failedSites };
      recentPresenceCache = { updatedAt: Date.now(), result };
      return result;
    })();
    try {
      return await recentPresenceRefresh;
    } finally {
      recentPresenceRefresh = null;
    }
  }

  function normalizedIncomingMessage(data) {
    if (data.type === 'text' && typeof data.content === 'string') {
      return { messageType: 'text', content: text(data.content, 4000) };
    }
    if (['file', 'animation', 'audio'].includes(data.type) && data.content && typeof data.content === 'object') {
      const fileUrl = text(data.content.url, 1000);
      if (!/^https?:\/\//i.test(fileUrl)) return null;
      const fileName = text(data.content.name, 500) || (data.type === 'audio' ? 'audio' : 'file');
      return {
        messageType: String(data.content.type || '').startsWith('image/') ? 'image' : 'file',
        content: '', fileUrl, fileName, fileSize: null
      };
    }
    const content = data.content && typeof data.content === 'object'
      ? text(data.content.text || data.content.value || JSON.stringify(data.content), 4000)
      : '';
    return content ? { messageType: 'text', content } : null;
  }

  async function handleWebhook(siteKey, suppliedSecret, payload) {
    const row = await siteRowByKey(siteKey);
    if (!row) {
      const error = new Error('网站不存在');
      error.statusCode = 404;
      throw error;
    }
    const config = await decodedConfig(row);
    if (!config.enabled || !secureEqual(suppliedSecret, config.webhookSecret)) {
      const error = new Error('Crisp Webhook 验证失败');
      error.statusCode = 401;
      throw error;
    }
    if (text(payload.website_id, 64) !== config.websiteId) {
      const error = new Error('Crisp Website ID 不匹配');
      error.statusCode = 403;
      throw error;
    }
    if (!['message:send', 'message:received'].includes(payload.event)) return { ignored: true };
    const data = payload.data || {};
    const visitorMessage = payload.event === 'message:send' && data.from === 'user';
    const operatorMessage = payload.event === 'message:received' && data.from === 'operator';
    if (!visitorMessage && !operatorMessage) return { ignored: true };
    const incoming = normalizedIncomingMessage(data);
    if (!incoming) return { ignored: true };
    const fingerprint = Number(data.fingerprint);
    if (!Number.isSafeInteger(fingerprint) || fingerprint <= 0) throw new Error('Crisp 消息指纹无效');
    const conversation = await ensureConversation(row, data, visitorMessage);
    const [existing] = await pool.execute(
      'SELECT id FROM messages WHERE conversation_id=? AND crisp_fingerprint=? LIMIT 1',
      [conversation.id, fingerprint]
    );
    if (existing.length) return { duplicate: true };
    await enrichConversation(config, conversation)
      .catch(error => console.error('Crisp conversation sync:', error));
    let message;
    try {
      message = await createMessage(conversation.id, visitorMessage ? 'visitor' : 'agent', {
        ...incoming,
        crispFingerprint: fingerprint,
        skipCrisp: true,
        skipTelegram: visitorMessage && incoming.messageType === 'text'
      });
    } catch (error) {
      if (error.code === 'ER_DUP_ENTRY') return { duplicate: true };
      throw error;
    }
    if (visitorMessage && message.message_type === 'text') {
      await afterVisitorMessage(message).catch(error => console.error('Keyword reply:', error));
    }
    return { messageId: message.id };
  }

  return {
    enqueueMessage,
    ensureSchema,
    handleWebhook,
    processOutbox,
    publicConfig,
    refreshPresence,
    refreshRecentPresence,
    saveConfig,
    secretValue,
    startWorker,
    testConnection
  };
}

module.exports = { createCrispBridge };
