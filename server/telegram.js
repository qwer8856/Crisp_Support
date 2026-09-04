const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

function createTelegramBridge(options) {
  const {
    pool,
    apiBase = 'https://api.telegram.org',
    uploadDir,
    uploadMaxMb,
    createMessage,
    getConfig
  } = options;
  const telegramBase = apiBase.replace(/\/$/, '');
  let processing = false;
  let workerTimer = null;
  let chatDiscovery = null;

  async function ensureColumn(table, column, definition) {
    const [rows] = await pool.execute(
      `SELECT 1 FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? AND COLUMN_NAME=? LIMIT 1`,
      [table, column]
    );
    if (!rows.length) await pool.query(`ALTER TABLE \`${table}\` ADD COLUMN \`${column}\` ${definition}`);
  }

  async function ensureSchema() {
    await ensureColumn('sites', 'telegram_chat_id', 'VARCHAR(64) NULL AFTER allowed_origins');
    await ensureColumn('visitors', 'external_user_id', 'VARCHAR(191) NULL AFTER email');
    await ensureColumn('visitors', 'identity_verified', 'TINYINT(1) NOT NULL DEFAULT 0 AFTER external_user_id');
    await ensureColumn('visitors', 'metadata_json', 'JSON NULL AFTER identity_verified');
    await ensureColumn('conversations', 'telegram_thread_id', 'BIGINT NULL AFTER last_message_at');
    await pool.query(`
      CREATE TABLE IF NOT EXISTS telegram_outbox (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        message_id BIGINT UNSIGNED NOT NULL,
        smart_reply_message_id BIGINT UNSIGNED NULL,
        status ENUM('pending','processing','sent','failed') NOT NULL DEFAULT 'pending',
        attempts INT UNSIGNED NOT NULL DEFAULT 0,
        next_attempt_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        last_error VARCHAR(1000) NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        UNIQUE KEY uk_telegram_outbox_message (message_id),
        KEY idx_telegram_outbox_pending (status, next_attempt_at),
        CONSTRAINT fk_telegram_outbox_message FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    await ensureColumn('telegram_outbox', 'smart_reply_message_id', 'BIGINT UNSIGNED NULL AFTER message_id');
    await pool.query(`
      CREATE TABLE IF NOT EXISTS telegram_updates (
        update_id BIGINT NOT NULL,
        processed_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (update_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    await pool.query("UPDATE telegram_outbox SET status='pending' WHERE status='processing'");
  }

  async function currentConfig() {
    const config = await getConfig();
    return {
      token: String(config.telegramBotToken || '').trim(),
      webhookSecret: String(config.telegramWebhookSecret || '').trim(),
      publicBaseUrl: String(config.publicBaseUrl || '').replace(/\/$/, '')
    };
  }

  async function call(method, payload, suppliedToken = '') {
    const token = suppliedToken || (await currentConfig()).token;
    if (!token) throw new Error('请先在管理网页保存 Telegram Bot Token');
    const request = { method: 'POST' };
    if (payload instanceof FormData) {
      request.body = payload;
    } else {
      request.headers = { 'Content-Type': 'application/json' };
      request.body = JSON.stringify(payload || {});
    }
    const response = await fetch(`${telegramBase}/bot${token}/${method}`, request);
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.ok) throw new Error(data.description || `Telegram ${method} 请求失败`);
    return data.result;
  }

  function topicName(conversation) {
    const identity = conversation.email || conversation.display_name || conversation.external_user_id || `访客 ${String(conversation.visitor_key).slice(0, 8)}`;
    const name = String(identity).replace(/[\r\n\t]+/g, ' ').trim() || '访客';
    return `${name.slice(0, 112)} #${conversation.id}`.slice(0, 128);
  }

  function htmlText(value, maxLength) {
    return String(value || '')
      .slice(0, maxLength)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  function visitorMessageText(message, smartReply) {
    const hasSmartReply = Boolean(smartReply?.content);
    const content = htmlText(message.content, hasSmartReply ? 1950 : 4000);
    const parts = [`🧾 <b>消息内容</b>：\n${content}`];
    if (hasSmartReply) {
      parts.push(`💡 <b>智能回复</b>：\n${htmlText(smartReply.content, 1950)}`);
    }
    return parts.join('\n\n');
  }

  function jsonObject(value) {
    if (!value) return null;
    if (typeof value === 'object' && !Array.isArray(value)) return value;
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }

  function externalUserId(conversation) {
    const value = String(conversation.external_user_id || '').trim();
    if (!value || value === conversation.crisp_session_id || value.startsWith('session_')) return '';
    return value;
  }

  function deviceName(value) {
    if (!value || typeof value !== 'object') return '未知';
    return [value.name, value.version].filter(Boolean).join(' ') || '未知';
  }

  function metadataText(conversation) {
    const metadata = jsonObject(conversation.metadata_json) || {};
    const context = jsonObject(conversation.context_json) || {};
    const userId = externalUserId(conversation);
    const user = conversation.display_name || userId || String(conversation.visitor_key || '').replace(/^crisp:/, '') || '未知访客';
    const signedIn = Boolean(conversation.identity_verified || conversation.email || userId);
    const location = context.location && typeof context.location === 'object'
      ? [...new Set([context.location.country, context.location.region, context.location.city].filter(Boolean))].join(' ')
      : '';
    const pages = Array.isArray(context.pages)
      ? context.pages.map(page => String(page?.url || '').trim()).filter(url => /^https?:\/\//i.test(url)).slice(0, 10)
      : [];
    const lines = [
      `网站: ${conversation.site_url}`,
      `访客类型: ${signedIn ? '已登录用户' : '未登录访客'}`,
      `用户: ${user}`
    ];
    if (conversation.email) lines.push(`邮箱: ${conversation.email}`);
    if (userId && userId !== user) lines.push(`用户 ID: ${userId}`);
    lines.push(
      `地理位置: ${location || '未知'}`,
      `操作系统: ${deviceName(context.os)}`,
      `浏览器: ${deviceName(context.browser)}`,
      '',
      '附加信息:',
      JSON.stringify(metadata, null, 2).slice(0, 1600),
      '',
      '访问历史:',
      ...(pages.length ? pages : ['暂无'])
    );
    return lines.join('\n').slice(0, 4000);
  }

  async function conversationDetails(conversationId) {
    const [rows] = await pool.execute(`
      SELECT c.id, c.telegram_thread_id, c.crisp_session_id,
             s.telegram_chat_id, s.allowed_origins AS site_url, s.agent_name,
             v.visitor_key, v.display_name, v.email, v.external_user_id,
             v.identity_verified, v.metadata_json, v.context_json, v.current_url
      FROM conversations c
      JOIN sites s ON s.id=c.site_id
      JOIN visitors v ON v.id=c.visitor_id
      WHERE c.id=? LIMIT 1`, [conversationId]);
    return rows[0] || null;
  }

  async function ensureTopic(conversationId) {
    const conversation = await conversationDetails(conversationId);
    if (!conversation || !conversation.telegram_chat_id) throw new Error('站点未配置 Telegram 群组 ID');
    if (conversation.telegram_thread_id) return conversation;
    const topic = await call('createForumTopic', {
      chat_id: conversation.telegram_chat_id,
      name: topicName(conversation)
    });
    await pool.execute('UPDATE conversations SET telegram_thread_id=? WHERE id=?', [topic.message_thread_id, conversationId]);
    conversation.telegram_thread_id = topic.message_thread_id;
    await call('sendMessage', {
      chat_id: conversation.telegram_chat_id,
      message_thread_id: conversation.telegram_thread_id,
      text: metadataText(conversation)
    });
    return conversation;
  }

  async function sendLocalFile(method, fieldName, message, conversation, caption, parseMode = '') {
    const parsed = new URL(message.file_url, 'http://localhost');
    const storedName = path.basename(decodeURIComponent(parsed.pathname));
    const localPath = path.join(uploadDir, storedName);
    const relative = path.relative(uploadDir, localPath);
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('附件路径无效');
    const buffer = await fs.promises.readFile(localPath);
    const form = new FormData();
    form.append('chat_id', String(conversation.telegram_chat_id));
    form.append('message_thread_id', String(conversation.telegram_thread_id));
    form.append('caption', caption.slice(0, 1024));
    if (parseMode) form.append('parse_mode', parseMode);
    form.append(fieldName, new Blob([buffer]), String(message.file_name || storedName).slice(0, 240));
    await call(method, form);
  }

  async function sendAttachment(method, fieldName, message, conversation, caption, parseMode = '') {
    const parsed = new URL(message.file_url);
    const config = await currentConfig();
    const localBase = config.publicBaseUrl ? new URL(config.publicBaseUrl) : null;
    const isLocalUpload = localBase
      && parsed.origin === localBase.origin
      && parsed.pathname.startsWith('/uploads/');
    if (isLocalUpload) {
      await sendLocalFile(method, fieldName, message, conversation, caption, parseMode);
      return;
    }
    if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('附件地址无效');
    await call(method, {
      chat_id: conversation.telegram_chat_id,
      message_thread_id: conversation.telegram_thread_id,
      caption: caption.slice(0, 1024),
      ...(parseMode ? { parse_mode: parseMode } : {}),
      [fieldName]: parsed.toString()
    });
  }

  async function forwardMessage(messageId, smartReplyMessageId = null) {
    const [rows] = await pool.execute(`
      SELECT m.*, smart_reply.content AS smart_reply_content
      FROM messages m
      LEFT JOIN messages smart_reply
        ON smart_reply.id=?
       AND smart_reply.conversation_id=m.conversation_id
       AND smart_reply.sender_type='agent'
       AND smart_reply.message_type='text'
      WHERE m.id=? LIMIT 1`, [smartReplyMessageId, messageId]);
    const message = rows[0];
    if (!message) return;
    const conversation = await ensureTopic(message.conversation_id);
    const sender = message.sender_type === 'agent'
        ? String(conversation.agent_name || '').trim() || '在线客服'
        : '系统消息';
    if (message.message_type === 'text') {
      const visitorText = message.sender_type === 'visitor'
        ? visitorMessageText(message, message.smart_reply_content ? { content: message.smart_reply_content } : null)
        : '';
      await call('sendMessage', {
        chat_id: conversation.telegram_chat_id,
        message_thread_id: conversation.telegram_thread_id,
        text: visitorText || `${sender}:\n${message.content}`.slice(0, 4096),
        ...(visitorText ? { parse_mode: 'HTML' } : {})
      });
      return;
    }
    const visitorAttachment = message.sender_type === 'visitor';
    const attachmentName = message.file_name || (message.message_type === 'image' ? '图片' : '文件');
    const caption = visitorAttachment
      ? `🧾 <b>消息内容</b>：\n${htmlText(attachmentName, 900)}`
      : `${sender}: ${attachmentName}`;
    const parseMode = visitorAttachment ? 'HTML' : '';
    if (message.message_type === 'image') {
      await sendAttachment('sendPhoto', 'photo', message, conversation, caption, parseMode);
    } else {
      await sendAttachment('sendDocument', 'document', message, conversation, caption, parseMode);
    }
  }

  async function enqueueMessage(messageId, options = {}) {
    const suppliedSmartReplyId = Number(options.smartReplyMessageId);
    const smartReplyMessageId = Number.isSafeInteger(suppliedSmartReplyId) && suppliedSmartReplyId > 0
      ? suppliedSmartReplyId
      : null;
    await pool.execute(`
      INSERT IGNORE INTO telegram_outbox(message_id,smart_reply_message_id)
      SELECT m.id, ? FROM messages m
      JOIN conversations c ON c.id=m.conversation_id
      JOIN sites s ON s.id=c.site_id
      WHERE m.id=? AND s.telegram_chat_id IS NOT NULL AND s.telegram_chat_id<>''`, [smartReplyMessageId, messageId]);
    if (smartReplyMessageId) {
      await pool.execute(
        'UPDATE telegram_outbox SET smart_reply_message_id=? WHERE message_id=?',
        [smartReplyMessageId, messageId]
      );
    }
    processOutbox().catch(error => console.error('Telegram outbox:', error));
  }

  async function processOutbox() {
    if (processing || !(await currentConfig()).token) return;
    processing = true;
    try {
      const [items] = await pool.execute(`
        SELECT id, message_id, smart_reply_message_id, attempts FROM telegram_outbox
        WHERE status IN ('pending','failed') AND attempts<20 AND next_attempt_at<=NOW()
        ORDER BY id ASC LIMIT 10`);
      for (const item of items) {
        const [claimed] = await pool.execute(
          "UPDATE telegram_outbox SET status='processing' WHERE id=? AND status IN ('pending','failed')",
          [item.id]
        );
        if (!claimed.affectedRows) continue;
        try {
          await forwardMessage(item.message_id, item.smart_reply_message_id);
          await pool.execute("UPDATE telegram_outbox SET status='sent', last_error=NULL WHERE id=?", [item.id]);
        } catch (error) {
          const attempts = item.attempts + 1;
          const delaySeconds = Math.min(300, 2 ** Math.min(attempts, 8));
          const nextAttempt = new Date(Date.now() + delaySeconds * 1000);
          await pool.execute(
            "UPDATE telegram_outbox SET status='failed', attempts=?, next_attempt_at=?, last_error=? WHERE id=?",
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
    workerTimer = setInterval(() => processOutbox().catch(error => console.error('Telegram outbox:', error)), 2500);
    workerTimer.unref();
    processOutbox().catch(error => console.error('Telegram outbox:', error));
  }

  async function verifyWebhookSecret(value) {
    const { token, webhookSecret } = await currentConfig();
    if (!token || !webhookSecret || !value) return false;
    const actual = Buffer.from(String(value));
    const expected = Buffer.from(String(webhookSecret));
    return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
  }

  async function downloadIncomingFile(fileId, originalName, fallbackExtension) {
    const config = await currentConfig();
    if (!config.publicBaseUrl) throw new Error('请先在管理网页配置客服系统公网地址');
    const file = await call('getFile', { file_id: fileId }, config.token);
    const response = await fetch(`${telegramBase}/file/bot${config.token}/${file.file_path}`);
    if (!response.ok) throw new Error('Telegram 文件下载失败');
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > uploadMaxMb * 1024 * 1024) throw new Error('Telegram 文件超过上传限制');
    const suppliedExtension = path.extname(originalName || '').toLowerCase();
    const extension = /^\.[a-z0-9]{1,10}$/.test(suppliedExtension) ? suppliedExtension : fallbackExtension;
    const storedName = `${Date.now()}-${crypto.randomBytes(8).toString('hex')}${extension}`;
    await fs.promises.writeFile(path.join(uploadDir, storedName), buffer, { flag: 'wx' });
    return {
      fileUrl: `${config.publicBaseUrl}/uploads/${encodeURIComponent(storedName)}`,
      fileName: String(originalName || storedName).slice(0, 500),
      fileSize: buffer.length,
      localPath: path.join(uploadDir, storedName)
    };
  }

  async function handleWebhook(update) {
    const updateId = Number(update && update.update_id);
    if (!Number.isSafeInteger(updateId)) return;
    const [inserted] = await pool.execute('INSERT IGNORE INTO telegram_updates(update_id) VALUES(?)', [updateId]);
    if (!inserted.affectedRows) return;
    try {
      const message = update.message;
      if (!message || message.from?.is_bot || !message.message_thread_id) return;
      const [rows] = await pool.execute(`
        SELECT c.id FROM conversations c
        JOIN sites s ON s.id=c.site_id
        WHERE c.telegram_thread_id=? AND s.telegram_chat_id=? LIMIT 1`,
        [message.message_thread_id, String(message.chat && message.chat.id)]
      );
      if (!rows.length) return;
      const conversationId = rows[0].id;
      if (message.text) {
        await createMessage(conversationId, 'agent', { content: message.text, messageType: 'text', skipTelegram: true });
      } else if (message.photo && message.photo.length) {
        const photo = message.photo[message.photo.length - 1];
        let file;
        try {
          file = await downloadIncomingFile(photo.file_id, `${photo.file_unique_id || 'telegram-photo'}.jpg`, '.jpg');
          await createMessage(conversationId, 'agent', { ...file, content: message.caption, messageType: 'image', skipTelegram: true });
        } catch (error) {
          if (file?.localPath) await fs.promises.unlink(file.localPath).catch(() => {});
          throw error;
        }
      } else if (message.document) {
        let file;
        try {
          file = await downloadIncomingFile(message.document.file_id, message.document.file_name, '.bin');
          await createMessage(conversationId, 'agent', { ...file, content: message.caption, messageType: 'file', skipTelegram: true });
        } catch (error) {
          if (file?.localPath) await fs.promises.unlink(file.localPath).catch(() => {});
          throw error;
        }
      }
    } catch (error) {
      await pool.execute('DELETE FROM telegram_updates WHERE update_id=?', [updateId]);
      throw error;
    }
  }

  async function configureWebhook() {
    const config = await currentConfig();
    if (!config.token) throw new Error('请先在管理网页保存 Telegram Bot Token');
    if (!config.webhookSecret) throw new Error('请先在管理网页生成 Webhook 密钥');
    if (!config.publicBaseUrl) throw new Error('请先在管理网页配置客服系统公网地址');
    if (telegramBase === 'https://api.telegram.org' && !config.publicBaseUrl.startsWith('https://')) {
      throw new Error('Telegram Webhook 需要公网 HTTPS 客服地址');
    }
    const webhookUrl = `${config.publicBaseUrl}/api/telegram/webhook`;
    const bot = await call('getMe', {}, config.token);
    await call('setWebhook', {
      url: webhookUrl,
      secret_token: config.webhookSecret,
      allowed_updates: ['message'],
      drop_pending_updates: false
    }, config.token);
    return { webhookUrl, botUsername: bot.username || null };
  }

  async function disableWebhook() {
    const config = await currentConfig();
    if (!config.token) throw new Error('请先在管理网页保存 Telegram Bot Token');
    const webhook = await call('getWebhookInfo', {}, config.token);
    if (!webhook?.url) return { webhookActive: false, webhookUrl: '' };
    await call('deleteWebhook', { drop_pending_updates: false }, config.token);
    return { webhookActive: false, webhookUrl: '', previousWebhookUrl: webhook.url };
  }

  async function discoverChats() {
    const config = await currentConfig();
    if (!config.token) throw new Error('请先在管理网页保存 Telegram Bot Token');
    const webhook = await call('getWebhookInfo', {}, config.token);
    const webhookWasActive = Boolean(webhook?.url);
    if (webhookWasActive && webhook.has_custom_certificate) {
      throw new Error('当前 Webhook 使用了自定义证书，系统无法自动恢复，请先停止 Webhook 再读取群组');
    }
    if (webhookWasActive && !config.webhookSecret) {
      throw new Error('当前 Webhook 已启用，但缺少本系统的 Webhook 密钥，无法安全暂停并恢复');
    }

    let updates;
    let readError = null;
    let restoreError = null;
    if (webhookWasActive) {
      await call('deleteWebhook', { drop_pending_updates: false }, config.token);
    }
    try {
      updates = await call('getUpdates', {
        allowed_updates: ['message'],
        limit: 100,
        timeout: 0
      }, config.token);
    } catch (error) {
      readError = error;
    } finally {
      if (webhookWasActive) {
        const restorePayload = {
          url: webhook.url,
          secret_token: config.webhookSecret,
          allowed_updates: Array.isArray(webhook.allowed_updates) ? webhook.allowed_updates : ['message'],
          drop_pending_updates: false
        };
        if (Number.isSafeInteger(webhook.max_connections)) {
          restorePayload.max_connections = webhook.max_connections;
        }
        try {
          await call('setWebhook', restorePayload, config.token);
        } catch (error) {
          restoreError = error;
        }
      }
    }

    if (restoreError) {
      const prefix = readError ? `${readError.message}；` : '';
      throw new Error(`${prefix}Webhook 自动恢复失败：${restoreError.message}`);
    }
    if (readError) throw readError;

    const chats = new Map();
    for (const update of Array.isArray(updates) ? updates : []) {
      const chat = update.message?.chat;
      if (!chat || !['group', 'supergroup'].includes(chat.type)) continue;
      chats.set(String(chat.id), {
        id: String(chat.id),
        title: String(chat.title || `群组 ${chat.id}`).slice(0, 200),
        type: chat.type
      });
    }
    return {
      chats: Array.from(chats.values()),
      webhookPaused: webhookWasActive,
      webhookRestored: webhookWasActive,
      webhookActive: webhookWasActive
    };
  }

  async function listChats() {
    if (!chatDiscovery) {
      chatDiscovery = discoverChats().finally(() => {
        chatDiscovery = null;
      });
    }
    return chatDiscovery;
  }

  async function status() {
    const config = await currentConfig();
    const webhook = config.token ? await call('getWebhookInfo', {}, config.token) : null;
    return {
      configured: Boolean(config.token),
      webhookSecretConfigured: Boolean(config.webhookSecret),
      publicBaseUrlConfigured: Boolean(config.publicBaseUrl),
      webhookUrl: config.publicBaseUrl ? `${config.publicBaseUrl}/api/telegram/webhook` : '',
      webhookActive: Boolean(webhook?.url),
      activeWebhookUrl: webhook?.url || ''
    };
  }

  return {
    configureWebhook,
    disableWebhook,
    enqueueMessage,
    ensureSchema,
    handleWebhook,
    listChats,
    processOutbox,
    startWorker,
    status,
    verifyWebhookSecret
  };
}

module.exports = { createTelegramBridge };
