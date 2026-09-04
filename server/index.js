require('dotenv').config();
const path = require('path');
const fs = require('fs');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const rateLimit = require('express-rate-limit');
const mysql = require('mysql2/promise');
const { Server } = require('socket.io');
const { createTelegramBridge } = require('./telegram');
const { createCrispBridge } = require('./crisp');
const { createSettingsStore } = require('./settings');

const PORT = Number(process.env.PORT || 3180);
const JWT_SECRET = process.env.JWT_SECRET || 'dev-only-change-this-secret';
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin@example.com';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'change-me-now';
const UPLOAD_MAX_MB = Number(process.env.UPLOAD_MAX_MB || 10);
const TELEGRAM_API_BASE = process.env.TELEGRAM_API_BASE || 'https://api.telegram.org';
const CRISP_API_BASE = process.env.CRISP_API_BASE || 'https://api.crisp.chat/v1';
let telegramBridge = null;
let crispBridge = null;

const databaseConfig = {
  host: process.env.DB_HOST || '127.0.0.1',
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER || 'support',
  password: process.env.DB_PASSWORD || 'support',
  database: process.env.DB_NAME || 'support_chat',
  charset: 'utf8mb4'
};
const pool = mysql.createPool({
  ...databaseConfig,
  waitForConnections: true,
  connectionLimit: 10
});
const dataDir = path.join(__dirname, '..', 'data');
const settingsStore = createSettingsStore({ pool, dataDir });

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: true, credentials: false },
  transports: ['websocket', 'polling']
});

app.set('trust proxy', 1);
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginResourcePolicy: { policy: 'cross-origin' },
  frameguard: false
}));
app.use(cors({ origin: true }));
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

const publicLimiter = rateLimit({ windowMs: 60_000, limit: 120, standardHeaders: 'draft-8', legacyHeaders: false });
app.use('/api/public', publicLimiter);
const crispWebhookLimiter = rateLimit({ windowMs: 60_000, limit: 300, standardHeaders: 'draft-8', legacyHeaders: false });

const uploadDir = path.join(__dirname, '..', 'uploads');
fs.mkdirSync(uploadDir, { recursive: true });
const storage = multer.diskStorage({
  destination: (_, __, cb) => cb(null, uploadDir),
  filename: (_, file, cb) => {
    const ext = path.extname(file.originalname || '').slice(0, 12);
    cb(null, `${Date.now()}-${crypto.randomBytes(8).toString('hex')}${ext}`);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: UPLOAD_MAX_MB * 1024 * 1024 },
  fileFilter: (_, file, cb) => {
    const ok = /^(image\/|text\/plain$|application\/pdf$|application\/zip$|application\/x-zip-compressed$)/i.test(file.mimetype);
    cb(ok ? null : new Error('不支持的文件类型'), ok);
  }
});

function signVisitor(payload) {
  return jwt.sign({ ...payload, role: 'visitor' }, JWT_SECRET, { expiresIn: '30d' });
}
function signAdmin() {
  return jwt.sign({ email: ADMIN_EMAIL, role: 'admin' }, JWT_SECRET, { expiresIn: '12h' });
}
function auth(requiredRole) {
  return (req, res, next) => {
    const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    try {
      const decoded = jwt.verify(token, JWT_SECRET);
      if (requiredRole && decoded.role !== requiredRole) return res.status(403).json({ error: '权限不足' });
      req.auth = decoded;
      next();
    } catch {
      res.status(401).json({ error: '登录状态无效或已过期' });
    }
  };
}
function normalizeOrigins(value) {
  if (!value || value.trim() === '*') return ['*'];
  return value.split(',').map(v => v.trim()).filter(Boolean);
}
function originAllowed(allowed, parentOrigin) {
  const list = normalizeOrigins(allowed);
  if (list.includes('*')) return true;
  if (!parentOrigin) return false;
  return list.includes(parentOrigin);
}
function normalizeWebsiteUrl(value) {
  const raw = safeText(value, 500);
  let parsed;
  try { parsed = new URL(raw); } catch { throw new Error('请输入完整的网站地址，例如 https://example.com'); }
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('网站地址只支持 http 或 https');
  if (parsed.username || parsed.password) throw new Error('网站地址不能包含账号或密码');
  return parsed.origin;
}
function normalizePublicBaseUrl(value) {
  const raw = safeText(value, 500);
  if (!raw) return '';
  let parsed;
  try { parsed = new URL(raw); } catch { throw new Error('请输入完整的客服系统公网地址'); }
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('客服系统地址只支持 http 或 https');
  if (parsed.username || parsed.password) throw new Error('客服系统地址不能包含账号或密码');
  return parsed.origin;
}
function safeText(value, max = 4000) {
  return String(value || '').trim().slice(0, max);
}
function safeMetadata(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const result = {};
  for (const [rawKey, rawValue] of Object.entries(value).slice(0, 20)) {
    if (!['string', 'number', 'boolean'].includes(typeof rawValue)) continue;
    const key = safeText(rawKey, 64);
    if (!key) continue;
    const next = { ...result, [key]: typeof rawValue === 'string' ? safeText(rawValue, 500) : rawValue };
    if (JSON.stringify(next).length > 4000) break;
    Object.assign(result, next);
  }
  return Object.keys(result).length ? JSON.stringify(result) : null;
}
async function visitorIdentity(body, site) {
  const user = body.user && typeof body.user === 'object' ? body.user : {};
  let identity = {
    displayName: safeText(user.name || body.displayName, 120) || null,
    email: safeText(user.email || body.email, 190) || null,
    externalUserId: safeText(user.id, 191) || null,
    metadataJson: safeMetadata(user.metadata),
    verified: 0
  };
  const identityToken = safeText(body.identityToken, 8000);
  if (!identityToken) return identity;
  const { visitorIdentitySecret, unreadableSecretKeys } = await settingsStore.getAll();
  if (unreadableSecretKeys.includes('visitor_identity_secret')) {
    const error = new Error('登录用户签名密钥无法读取，请重新配置');
    error.statusCode = 503;
    throw error;
  }
  if (!visitorIdentitySecret) {
    const error = new Error('服务端未配置登录用户签名密钥');
    error.statusCode = 503;
    throw error;
  }
  try {
    const claims = jwt.verify(identityToken, visitorIdentitySecret, { algorithms: ['HS256'] });
    if (claims.siteKey !== site.site_key) throw new Error('siteKey mismatch');
    identity = {
      displayName: safeText(claims.name, 120) || null,
      email: safeText(claims.email, 190) || null,
      externalUserId: safeText(claims.sub, 191) || null,
      metadataJson: safeMetadata(claims.metadata),
      verified: 1
    };
    return identity;
  } catch {
    const error = new Error('登录用户身份签名无效或已过期');
    error.statusCode = 401;
    throw error;
  }
}
async function publicBaseUrl(req) {
  return await settingsStore.getPublicBaseUrl() || `${req.protocol}://${req.get('host')}`;
}
async function getSite(siteKey) {
  const [rows] = await pool.execute('SELECT * FROM sites WHERE site_key = ? LIMIT 1', [siteKey]);
  return rows[0] || null;
}
async function canAccessConversation(authData, conversationId) {
  if (authData.role === 'admin') return true;
  const [rows] = await pool.execute(
    `SELECT c.id FROM conversations c JOIN visitors v ON v.id=c.visitor_id
     WHERE c.id=? AND c.id=? AND v.visitor_key=? AND c.site_id=? LIMIT 1`,
    [conversationId, authData.conversationId, authData.visitorKey, authData.siteId]
  );
  return rows.length > 0;
}
async function emitConversationUpdate(conversationId) {
  const [rows] = await pool.execute(`
    SELECT c.*, s.site_key, s.name AS site_name, s.allowed_origins AS site_url,
           v.visitor_key, v.display_name, v.email, v.external_user_id,
           v.identity_verified, v.metadata_json, v.context_json, v.current_url, v.current_title,
           v.user_agent, v.ip_address, v.last_seen_at, v.is_online, v.presence_checked_at,
           TIMESTAMPDIFF(SECOND,v.presence_checked_at,NOW()) AS presence_age_seconds
    FROM conversations c
    JOIN sites s ON s.id=c.site_id
    JOIN visitors v ON v.id=c.visitor_id
    WHERE c.id=? LIMIT 1`, [conversationId]);
  if (rows[0]) io.to('admins').emit('conversation:updated', rows[0]);
}

async function ensureCoreSchema() {
  const schemaSql = await fs.promises.readFile(path.join(__dirname, 'schema.sql'), 'utf8');
  // Multiple statements are enabled only for this trusted, local schema file.
  const connection = await mysql.createConnection({ ...databaseConfig, multipleStatements: true });
  try {
    await connection.query(schemaSql);
  } finally {
    await connection.end();
  }
}

async function ensureKeywordReplySchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS keyword_replies (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      site_id BIGINT UNSIGNED NOT NULL,
      keyword VARCHAR(200) NOT NULL,
      reply_text TEXT NOT NULL,
      match_type ENUM('contains','exact') NOT NULL DEFAULT 'contains',
      enabled TINYINT(1) NOT NULL DEFAULT 1,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uk_keyword_replies_site_rule (site_id, keyword, match_type),
      KEY idx_keyword_replies_site_enabled (site_id, enabled),
      CONSTRAINT fk_keyword_replies_site FOREIGN KEY (site_id) REFERENCES sites(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
}

function normalizedKeywordText(value) {
  return String(value || '').normalize('NFKC').trim().toLocaleLowerCase();
}

function keywordTerms(value) {
  const terms = [];
  const seen = new Set();
  String(value || '').split(/[\r\n,，、|;；]+/u).forEach(item => {
    const term = item.normalize('NFKC').trim();
    const normalized = normalizedKeywordText(term);
    if (!normalized || seen.has(normalized)) return;
    seen.add(normalized);
    terms.push(term);
  });
  return terms;
}

function normalizedKeywordRule(value) {
  return safeText(keywordTerms(safeText(value, 200)).join('|'), 200);
}

function keywordEnabledValue(value, fallback = 1) {
  if (value === undefined) return fallback;
  return [true, 1, '1', 'true'].includes(value) ? 1 : 0;
}

async function createKeywordReplyForMessage(conversationId, content, options = {}) {
  const normalizedContent = normalizedKeywordText(content);
  if (!normalizedContent) return null;
  const [rules] = await pool.execute(`
    SELECT kr.id, kr.keyword, kr.reply_text, kr.match_type
    FROM keyword_replies kr
    JOIN conversations c ON c.site_id=kr.site_id
    WHERE c.id=? AND kr.enabled=1
    ORDER BY CASE kr.match_type WHEN 'exact' THEN 0 ELSE 1 END,
             CHAR_LENGTH(kr.keyword) DESC, kr.id ASC`, [conversationId]);
  const matches = [];
  rules.forEach(item => {
    keywordTerms(item.keyword).forEach(term => {
      const keyword = normalizedKeywordText(term);
      const matched = item.match_type === 'exact'
        ? normalizedContent === keyword
        : normalizedContent.includes(keyword);
      if (matched) matches.push({ item, keywordLength: keyword.length });
    });
  });
  matches.sort((left, right) => {
    const leftType = left.item.match_type === 'exact' ? 0 : 1;
    const rightType = right.item.match_type === 'exact' ? 0 : 1;
    return leftType - rightType
      || right.keywordLength - left.keywordLength
      || Number(left.item.id) - Number(right.item.id);
  });
  const rule = matches[0]?.item;
  if (!rule) return null;
  return createMessage(conversationId, 'agent', {
    content: rule.reply_text,
    messageType: 'text',
    skipTelegram: Boolean(options.skipTelegram)
  });
}

app.get('/api/health', async (_, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ ok: true, service: 'support-chat', time: new Date().toISOString() });
  } catch (e) {
    res.status(503).json({ ok: false, error: e.message });
  }
});

app.get('/api/public/site/:siteKey', async (req, res) => {
  const site = await getSite(req.params.siteKey);
  if (!site) return res.status(404).json({ error: '站点不存在' });
  const parentOrigin = safeText(req.query.origin, 500);
  if (!originAllowed(site.allowed_origins, parentOrigin)) return res.status(403).json({ error: '当前域名未授权使用此客服组件' });
  res.json({
    siteKey: site.site_key,
    name: site.name,
    agentName: site.agent_name,
    logoUrl: site.logo_url,
    welcomeText: site.welcome_text,
    headerText: site.header_text,
    launcherPosition: site.launcher_position
  });
});

app.post('/api/public/session', async (req, res) => {
  const siteKey = safeText(req.body.siteKey, 64);
  const visitorKey = safeText(req.body.visitorKey, 96) || crypto.randomUUID();
  const parentOrigin = safeText(req.body.parentOrigin, 500);
  const site = await getSite(siteKey);
  if (!site) return res.status(404).json({ error: '站点不存在' });
  if (site.integration_mode === 'crisp') return res.status(409).json({ error: '这个网站已使用 Crisp 托管模式' });
  if (!originAllowed(site.allowed_origins, parentOrigin)) return res.status(403).json({ error: '当前域名未授权使用此客服组件' });

  const identity = await visitorIdentity(req.body, site);
  const currentUrl = safeText(req.body.currentUrl, 1000) || null;
  const currentTitle = safeText(req.body.currentTitle, 500) || null;
  const ua = safeText(req.headers['user-agent'], 1000) || null;
  const ip = safeText(req.ip, 64) || null;

  await pool.execute(`
    INSERT INTO visitors(site_id, visitor_key, display_name, email, external_user_id, identity_verified, metadata_json,
                         current_url, current_title, user_agent, ip_address, last_seen_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,NOW())
    ON DUPLICATE KEY UPDATE
      display_name=IF(identity_verified=1 AND VALUES(identity_verified)=0, display_name, COALESCE(VALUES(display_name), display_name)),
      email=IF(identity_verified=1 AND VALUES(identity_verified)=0, email, COALESCE(VALUES(email), email)),
      external_user_id=IF(identity_verified=1 AND VALUES(identity_verified)=0, external_user_id, COALESCE(VALUES(external_user_id), external_user_id)),
      metadata_json=IF(identity_verified=1 AND VALUES(identity_verified)=0, metadata_json, COALESCE(VALUES(metadata_json), metadata_json)),
      identity_verified=GREATEST(identity_verified, VALUES(identity_verified)),
      current_url=VALUES(current_url), current_title=VALUES(current_title),
      user_agent=VALUES(user_agent), ip_address=VALUES(ip_address), last_seen_at=NOW()`,
    [site.id, visitorKey, identity.displayName, identity.email, identity.externalUserId, identity.verified,
      identity.metadataJson, currentUrl, currentTitle, ua, ip]
  );

  const [visitorRows] = await pool.execute('SELECT * FROM visitors WHERE site_id=? AND visitor_key=? LIMIT 1', [site.id, visitorKey]);
  const visitor = visitorRows[0];
  let [convRows] = await pool.execute('SELECT * FROM conversations WHERE site_id=? AND visitor_id=? AND status="open" ORDER BY id DESC LIMIT 1', [site.id, visitor.id]);
  if (!convRows.length) {
    const [result] = await pool.execute('INSERT INTO conversations(site_id, visitor_id, status, last_message_at) VALUES(?,?,"open",NOW())', [site.id, visitor.id]);
    [convRows] = await pool.execute('SELECT * FROM conversations WHERE id=?', [result.insertId]);
  }
  const conversation = convRows[0];
  const token = signVisitor({ siteId: site.id, siteKey: site.site_key, visitorKey, conversationId: conversation.id });
  res.json({ token, visitorKey, conversationId: conversation.id, site: { name: site.name, agentName: site.agent_name, logoUrl: site.logo_url, welcomeText: site.welcome_text, headerText: site.header_text } });
});

app.patch('/api/public/context', auth('visitor'), async (req, res) => {
  await pool.execute('UPDATE visitors SET current_url=?, current_title=?, last_seen_at=NOW() WHERE site_id=? AND visitor_key=?', [
    safeText(req.body.currentUrl, 1000) || null,
    safeText(req.body.currentTitle, 500) || null,
    req.auth.siteId,
    req.auth.visitorKey
  ]);
  await emitConversationUpdate(req.auth.conversationId);
  res.json({ ok: true });
});

app.get('/api/public/messages', auth('visitor'), async (req, res) => {
  const [rows] = await pool.execute('SELECT * FROM messages WHERE conversation_id=? ORDER BY id ASC LIMIT 500', [req.auth.conversationId]);
  await pool.execute('UPDATE conversations SET unread_visitor=0 WHERE id=?', [req.auth.conversationId]);
  res.json({ messages: rows });
});

async function createMessage(conversationId, senderType, data) {
  const content = safeText(data.content, 4000) || null;
  const messageType = ['text','file','image'].includes(data.messageType) ? data.messageType : 'text';
  if (messageType === 'text' && !content) throw new Error('消息不能为空');
  const [result] = await pool.execute(
    'INSERT INTO messages(conversation_id,sender_type,message_type,content,file_url,file_name,file_size,crisp_fingerprint) VALUES(?,?,?,?,?,?,?,?)',
    [conversationId, senderType, messageType, content, data.fileUrl || null, data.fileName || null, data.fileSize || null, data.crispFingerprint || null]
  );
  const [rows] = await pool.execute('SELECT * FROM messages WHERE id=? LIMIT 1', [result.insertId]);
  const msg = rows[0];
  const preview = messageType === 'text' ? content.slice(0, 500) : `[${messageType === 'image' ? '图片' : '文件'}] ${data.fileName || ''}`.slice(0, 500);
  if (senderType === 'visitor') {
    await pool.execute('UPDATE conversations SET status="open", unread_admin=unread_admin+1, last_message_preview=?, last_message_at=NOW() WHERE id=?', [preview, conversationId]);
  } else {
    await pool.execute('UPDATE conversations SET unread_visitor=unread_visitor+1, last_message_preview=?, last_message_at=NOW() WHERE id=?', [preview, conversationId]);
  }
  io.to(`conversation:${conversationId}`).emit('message:new', msg);
  await emitConversationUpdate(conversationId);
  if (!data.skipTelegram && telegramBridge) {
    await telegramBridge.enqueueMessage(msg.id).catch(error => console.error('Telegram enqueue:', error));
  }
  if (!data.skipCrisp && crispBridge) {
    await crispBridge.enqueueMessage(msg.id).catch(error => console.error('Crisp enqueue:', error));
  }
  return msg;
}

async function processVisitorText(message) {
  let smartReply = null;
  try {
    smartReply = await createKeywordReplyForMessage(message.conversation_id, message.content, { skipTelegram: true });
  } catch (error) {
    console.error('Keyword reply:', error);
  }
  if (telegramBridge) {
    await telegramBridge.enqueueMessage(message.id, { smartReplyMessageId: smartReply?.id })
      .catch(error => console.error('Telegram enqueue:', error));
  }
  return smartReply;
}

telegramBridge = createTelegramBridge({
  pool,
  apiBase: TELEGRAM_API_BASE,
  uploadDir,
  uploadMaxMb: UPLOAD_MAX_MB,
  createMessage,
  getConfig: () => settingsStore.getAll()
});

crispBridge = createCrispBridge({
  pool,
  apiBase: CRISP_API_BASE,
  createMessage,
  afterVisitorMessage: processVisitorText,
  encrypt: value => settingsStore.encrypt(value),
  decrypt: value => settingsStore.decrypt(value),
  getPublicBaseUrl: () => settingsStore.getPublicBaseUrl()
});

app.post('/api/public/messages', auth('visitor'), async (req, res) => {
  try {
    const msg = await createMessage(req.auth.conversationId, 'visitor', {
      content: req.body.content,
      messageType: 'text',
      skipTelegram: true
    });
    await processVisitorText(msg);
    res.status(201).json({ message: msg });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.post('/api/public/upload', auth('visitor'), upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: '请选择文件' });
  const isImage = req.file.mimetype.startsWith('image/');
  const fileUrl = `${await publicBaseUrl(req)}/uploads/${encodeURIComponent(req.file.filename)}`;
  const msg = await createMessage(req.auth.conversationId, 'visitor', {
    messageType: isImage ? 'image' : 'file', fileUrl, fileName: req.file.originalname, fileSize: req.file.size
  });
  res.status(201).json({ message: msg });
});

app.post('/api/admin/login', (req, res) => {
  const email = safeText(req.body.email, 190);
  const password = String(req.body.password || '');
  if (email !== ADMIN_EMAIL || password !== ADMIN_PASSWORD) return res.status(401).json({ error: '邮箱或密码错误' });
  res.json({ token: signAdmin(), user: { email: ADMIN_EMAIL, name: '客服管理员' } });
});

app.get('/api/admin/sites', auth('admin'), async (_, res) => {
  const [rows] = await pool.execute('SELECT id, site_key, name, agent_name, logo_url, welcome_text, header_text, launcher_position, allowed_origins, telegram_chat_id, integration_mode, crisp_website_id FROM sites ORDER BY id ASC');
  res.json({ sites: rows });
});

app.post('/api/admin/sites', auth('admin'), async (req, res) => {
  try {
    const websiteUrl = normalizeWebsiteUrl(req.body.websiteUrl);
    const [existing] = await pool.execute('SELECT id FROM sites WHERE site_key=? LIMIT 1', [
      `site-${crypto.createHash('sha256').update(websiteUrl).digest('hex').slice(0, 16)}`
    ]);
    if (existing.length) return res.status(409).json({ error: '这个网站已经添加' });

    const parsed = new URL(websiteUrl);
    const siteKey = `site-${crypto.createHash('sha256').update(websiteUrl).digest('hex').slice(0, 16)}`;
    const name = safeText(req.body.name, 100) || parsed.hostname;
    const launcherPosition = req.body.launcherPosition === 'right' ? 'right' : 'left';
    const integrationMode = req.body.integrationMode === 'native' ? 'native' : 'crisp';
    const [result] = await pool.execute(
      `INSERT INTO sites(site_key,name,agent_name,welcome_text,header_text,launcher_position,allowed_origins,integration_mode)
       VALUES(?,?,'在线客服','请问有什么可以帮您？','有疑问吗？联系我们！',?,?,?)`,
      [siteKey, name, launcherPosition, websiteUrl, integrationMode]
    );
    const [rows] = await pool.execute(
      'SELECT id, site_key, name, agent_name, logo_url, welcome_text, header_text, launcher_position, allowed_origins, telegram_chat_id, integration_mode, crisp_website_id FROM sites WHERE id=? LIMIT 1',
      [result.insertId]
    );
    res.status(201).json({ site: rows[0] });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.get('/api/admin/sites/:id/keyword-replies', auth('admin'), async (req, res) => {
  const siteId = Number(req.params.id);
  if (!Number.isSafeInteger(siteId) || siteId <= 0) return res.status(400).json({ error: '网站 ID 无效' });
  const [siteRows] = await pool.execute('SELECT id FROM sites WHERE id=? LIMIT 1', [siteId]);
  if (!siteRows.length) return res.status(404).json({ error: '网站不存在' });
  const [rows] = await pool.execute(`
    SELECT id, site_id, keyword, reply_text, match_type, enabled, created_at, updated_at
    FROM keyword_replies WHERE site_id=? ORDER BY id ASC`, [siteId]);
  res.json({ keywordReplies: rows });
});

app.post('/api/admin/sites/:id/keyword-replies', auth('admin'), async (req, res) => {
  try {
    const siteId = Number(req.params.id);
    if (!Number.isSafeInteger(siteId) || siteId <= 0) return res.status(400).json({ error: '网站 ID 无效' });
    const keyword = normalizedKeywordRule(req.body.keyword);
    const replyText = safeText(req.body.replyText, 4000);
    const matchType = req.body.matchType === 'exact' ? 'exact' : 'contains';
    const enabled = keywordEnabledValue(req.body.enabled);
    if (!keyword) throw new Error('请输入关键词');
    if (!replyText) throw new Error('请输入回复内容');
    const [siteRows] = await pool.execute('SELECT id FROM sites WHERE id=? LIMIT 1', [siteId]);
    if (!siteRows.length) return res.status(404).json({ error: '网站不存在' });
    const [result] = await pool.execute(
      'INSERT INTO keyword_replies(site_id,keyword,reply_text,match_type,enabled) VALUES(?,?,?,?,?)',
      [siteId, keyword, replyText, matchType, enabled]
    );
    const [rows] = await pool.execute(`
      SELECT id, site_id, keyword, reply_text, match_type, enabled, created_at, updated_at
      FROM keyword_replies WHERE id=? LIMIT 1`, [result.insertId]);
    res.status(201).json({ keywordReply: rows[0] });
  } catch (error) {
    const duplicate = error.code === 'ER_DUP_ENTRY';
    res.status(duplicate ? 409 : 400).json({
      error: duplicate ? '这个关键词规则已经存在' : error.message
    });
  }
});

app.patch('/api/admin/keyword-replies/:id', auth('admin'), async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isSafeInteger(id) || id <= 0) return res.status(400).json({ error: '关键词规则 ID 无效' });
    const [existingRows] = await pool.execute('SELECT * FROM keyword_replies WHERE id=? LIMIT 1', [id]);
    if (!existingRows.length) return res.status(404).json({ error: '关键词规则不存在' });
    const existing = existingRows[0];
    const keyword = Object.hasOwn(req.body, 'keyword') ? normalizedKeywordRule(req.body.keyword) : existing.keyword;
    const replyText = Object.hasOwn(req.body, 'replyText') ? safeText(req.body.replyText, 4000) : existing.reply_text;
    const matchType = Object.hasOwn(req.body, 'matchType')
      ? (req.body.matchType === 'exact' ? 'exact' : 'contains')
      : existing.match_type;
    const enabled = keywordEnabledValue(req.body.enabled, existing.enabled);
    if (!keyword) throw new Error('请输入关键词');
    if (!replyText) throw new Error('请输入回复内容');
    await pool.execute(
      'UPDATE keyword_replies SET keyword=?,reply_text=?,match_type=?,enabled=? WHERE id=?',
      [keyword, replyText, matchType, enabled, id]
    );
    const [rows] = await pool.execute(`
      SELECT id, site_id, keyword, reply_text, match_type, enabled, created_at, updated_at
      FROM keyword_replies WHERE id=? LIMIT 1`, [id]);
    res.json({ keywordReply: rows[0] });
  } catch (error) {
    const duplicate = error.code === 'ER_DUP_ENTRY';
    res.status(duplicate ? 409 : 400).json({
      error: duplicate ? '这个关键词规则已经存在' : error.message
    });
  }
});

app.delete('/api/admin/keyword-replies/:id', auth('admin'), async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isSafeInteger(id) || id <= 0) return res.status(400).json({ error: '关键词规则 ID 无效' });
  const [result] = await pool.execute('DELETE FROM keyword_replies WHERE id=?', [id]);
  if (!result.affectedRows) return res.status(404).json({ error: '关键词规则不存在' });
  res.json({ ok: true });
});

app.get('/api/admin/sites/:id/crisp', auth('admin'), async (req, res) => {
  const siteId = Number(req.params.id);
  if (!Number.isSafeInteger(siteId) || siteId <= 0) return res.status(400).json({ error: '网站 ID 无效' });
  const config = await crispBridge.publicConfig(siteId);
  if (!config) return res.status(404).json({ error: '网站不存在' });
  res.json({ crisp: config });
});

app.get('/api/admin/sites/:id/crisp/secret/:field', auth('admin'), async (req, res) => {
  try {
    const siteId = Number(req.params.id);
    if (!Number.isSafeInteger(siteId) || siteId <= 0) return res.status(400).json({ error: '网站 ID 无效' });
    if (!['tokenIdentifier', 'tokenKey'].includes(req.params.field)) {
      return res.status(400).json({ error: 'Crisp 凭证字段无效' });
    }
    const secret = await crispBridge.secretValue(siteId, req.params.field);
    if (!secret) return res.status(404).json({ error: '网站不存在' });
    res.set('Cache-Control', 'no-store');
    res.json(secret);
  } catch (error) {
    res.status(error.code === 'SETTINGS_DECRYPT_FAILED' ? 409 : 400).json({
      error: error.message || 'Crisp 凭证读取失败'
    });
  }
});

app.patch('/api/admin/sites/:id/crisp', auth('admin'), async (req, res) => {
  try {
    const siteId = Number(req.params.id);
    if (!Number.isSafeInteger(siteId) || siteId <= 0) return res.status(400).json({ error: '网站 ID 无效' });
    const config = await crispBridge.saveConfig(siteId, req.body || {});
    if (!config) return res.status(404).json({ error: '网站不存在' });
    const [siteRows] = await pool.execute(
      'SELECT id, site_key, name, agent_name, logo_url, welcome_text, header_text, launcher_position, allowed_origins, telegram_chat_id, integration_mode, crisp_website_id FROM sites WHERE id=? LIMIT 1',
      [siteId]
    );
    res.json({ crisp: config, site: siteRows[0] });
  } catch (error) {
    res.status(400).json({ error: error.message || 'Crisp 配置保存失败' });
  }
});

app.post('/api/admin/sites/:id/crisp/test', auth('admin'), async (req, res) => {
  try {
    const siteId = Number(req.params.id);
    if (!Number.isSafeInteger(siteId) || siteId <= 0) return res.status(400).json({ error: '网站 ID 无效' });
    res.json({ ok: true, ...(await crispBridge.testConnection(siteId)) });
  } catch (error) {
    res.status(502).json({ error: error.message || 'Crisp 连接测试失败' });
  }
});

function publicSettings(settings) {
  const token = settings.telegramBotToken || '';
  const unreadable = new Set(settings.unreadableSecretKeys || []);
  return {
    publicBaseUrl: settings.publicBaseUrl || '',
    telegramBotTokenConfigured: Boolean(token),
    telegramBotTokenHint: token ? `••••${token.slice(-6)}` : '',
    telegramWebhookSecretConfigured: Boolean(settings.telegramWebhookSecret),
    visitorIdentitySecretConfigured: Boolean(settings.visitorIdentitySecret),
    telegramRecoveryRequired: unreadable.has('telegram_bot_token') || unreadable.has('telegram_webhook_secret')
  };
}

app.get('/api/admin/settings', auth('admin'), async (req, res) => {
  res.json(publicSettings(await settingsStore.getAll()));
});

app.get('/api/admin/settings/secret/:field', auth('admin'), async (req, res) => {
  const fields = {
    telegramBotToken: 'telegramBotToken',
    telegramWebhookSecret: 'telegramWebhookSecret'
  };
  const settingKey = fields[req.params.field];
  if (!settingKey) return res.status(400).json({ error: '敏感配置字段无效' });
  const settings = await settingsStore.getAll();
  const databaseKey = settingKey === 'telegramBotToken' ? 'telegram_bot_token' : 'telegram_webhook_secret';
  if (settings.unreadableSecretKeys.includes(databaseKey)) {
    return res.status(409).json({ error: '该 Telegram 凭证无法解密，请重新填写 Bot Token 并保存' });
  }
  res.set('Cache-Control', 'no-store');
  res.json({ value: settings[settingKey] || '' });
});

app.patch('/api/admin/settings', auth('admin'), async (req, res) => {
  try {
    const current = await settingsStore.getAll();
    const updates = {};
    if (Object.hasOwn(req.body, 'publicBaseUrl')) {
      updates.public_base_url = normalizePublicBaseUrl(req.body.publicBaseUrl);
    }
    const botToken = safeText(req.body.telegramBotToken, 512);
    if (botToken) {
      if (!/^\d{5,15}:[A-Za-z0-9_-]{20,}$/.test(botToken)) throw new Error('Bot Token 格式无效');
      updates.telegram_bot_token = botToken;
    }
    if (req.body.clearTelegramBotToken === true) updates.telegram_bot_token = '';

    const webhookSecret = safeText(req.body.telegramWebhookSecret, 256);
    if (webhookSecret) {
      if (!/^[A-Za-z0-9_-]{16,256}$/.test(webhookSecret)) {
        throw new Error('Webhook 密钥只能包含字母、数字、下划线和连字符，至少 16 位');
      }
      updates.telegram_webhook_secret = webhookSecret;
    } else if (req.body.regenerateWebhookSecret === true || (!current.telegramWebhookSecret && botToken)) {
      updates.telegram_webhook_secret = crypto.randomBytes(32).toString('base64url');
    }
    if (req.body.clearTelegramBotToken === true) updates.telegram_webhook_secret = '';

    const identitySecret = safeText(req.body.visitorIdentitySecret, 512);
    if (identitySecret) {
      if (identitySecret.length < 32) throw new Error('登录用户签名密钥至少需要 32 位');
      updates.visitor_identity_secret = identitySecret;
    }
    if (req.body.clearVisitorIdentitySecret === true) updates.visitor_identity_secret = '';

    await settingsStore.setMany(updates);
    if (Object.hasOwn(updates, 'telegram_bot_token')) {
      await pool.query("UPDATE telegram_outbox SET status='pending', next_attempt_at=NOW(), last_error=NULL WHERE status='failed' AND attempts<20");
      telegramBridge.processOutbox().catch(error => console.error('Telegram outbox:', error));
    }
    res.json(publicSettings(await settingsStore.getAll()));
  } catch (error) {
    res.status(400).json({ error: error.message || '设置保存失败' });
  }
});

app.get('/api/admin/telegram/status', auth('admin'), async (req, res) => {
  try {
    res.json(await telegramBridge.status());
  } catch (error) {
    res.status(502).json({ error: error.message || 'Telegram 状态读取失败' });
  }
});

app.post('/api/admin/telegram/webhook', auth('admin'), async (req, res) => {
  try {
    const result = await telegramBridge.configureWebhook();
    res.json({ ok: true, ...result });
  } catch (error) {
    res.status(502).json({ error: error.message || 'Telegram Webhook 配置失败' });
  }
});

app.delete('/api/admin/telegram/webhook', auth('admin'), async (req, res) => {
  try {
    const result = await telegramBridge.disableWebhook();
    res.json({ ok: true, ...result });
  } catch (error) {
    res.status(502).json({ error: error.message || 'Telegram Webhook 停止失败' });
  }
});

app.get('/api/admin/telegram/chats', auth('admin'), async (req, res) => {
  try {
    res.json(await telegramBridge.listChats());
  } catch (error) {
    res.status(502).json({ error: error.message || 'Telegram 群组读取失败' });
  }
});

app.patch('/api/admin/sites/:id/telegram', auth('admin'), async (req, res) => {
  const siteId = Number(req.params.id);
  if (!Number.isSafeInteger(siteId) || siteId <= 0) return res.status(400).json({ error: '网站 ID 无效' });
  const telegramChatId = safeText(req.body.telegramChatId, 64);
  if (telegramChatId && !/^-\d{6,30}$/.test(telegramChatId)) {
    return res.status(400).json({ error: '请输入 Telegram 超级群组 ID，例如 -1001234567890' });
  }

  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const [siteRows] = await connection.execute(
      'SELECT telegram_chat_id FROM sites WHERE id=? LIMIT 1 FOR UPDATE',
      [siteId]
    );
    if (!siteRows.length) {
      await connection.rollback();
      return res.status(404).json({ error: '网站不存在' });
    }
    const previousChatId = siteRows[0].telegram_chat_id || '';
    const nextChatId = telegramChatId || null;
    await connection.execute('UPDATE sites SET telegram_chat_id=? WHERE id=?', [nextChatId, siteId]);
    if (previousChatId !== (nextChatId || '')) {
      await connection.execute('UPDATE conversations SET telegram_thread_id=NULL WHERE site_id=?', [siteId]);
      if (nextChatId) {
        await connection.execute(`
          UPDATE telegram_outbox o
          JOIN messages m ON m.id=o.message_id
          JOIN conversations c ON c.id=m.conversation_id
          SET o.status='pending', o.next_attempt_at=NOW(), o.last_error=NULL
          WHERE c.site_id=? AND o.status='failed' AND o.attempts<20`, [siteId]);
      }
    }
    await connection.commit();
    const [rows] = await pool.execute(
      'SELECT id, site_key, name, agent_name, logo_url, welcome_text, header_text, launcher_position, allowed_origins, telegram_chat_id, integration_mode, crisp_website_id FROM sites WHERE id=? LIMIT 1',
      [siteId]
    );
    res.json({ site: rows[0] });
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
});

app.post('/api/telegram/webhook', async (req, res) => {
  const status = await telegramBridge.status();
  if (!status.configured) return res.status(503).json({ error: 'Telegram 未配置' });
  const suppliedSecret = req.get('X-Telegram-Bot-Api-Secret-Token');
  if (!(await telegramBridge.verifyWebhookSecret(suppliedSecret))) {
    return res.status(401).json({ error: 'Webhook 密钥无效' });
  }
  try {
    await telegramBridge.handleWebhook(req.body);
    res.json({ ok: true });
  } catch (error) {
    console.error('Telegram webhook:', error);
    res.status(500).json({ error: 'Webhook 处理失败' });
  }
});

app.post('/api/crisp/webhook/:siteKey', crispWebhookLimiter, async (req, res) => {
  try {
    const result = await crispBridge.handleWebhook(req.params.siteKey, req.query.key, req.body || {});
    res.status(200).json({ ok: true, ...result });
  } catch (error) {
    res.status(error.statusCode || 400).json({ error: error.message || 'Crisp Webhook 处理失败' });
  }
});

app.get('/api/admin/conversations', auth('admin'), async (req, res) => {
  const siteKey = safeText(req.query.siteKey, 64);
  const params = [];
  let where = '';
  if (siteKey) { where = 'WHERE s.site_key=?'; params.push(siteKey); }
  const [rows] = await pool.execute(`
    SELECT c.*, s.site_key, s.name AS site_name, s.allowed_origins AS site_url,
           v.visitor_key, v.display_name, v.email, v.external_user_id,
           v.identity_verified, v.metadata_json, v.context_json, v.current_url, v.current_title,
           v.user_agent, v.ip_address, v.last_seen_at, v.is_online, v.presence_checked_at,
           TIMESTAMPDIFF(SECOND,v.presence_checked_at,NOW()) AS presence_age_seconds
    FROM conversations c
    JOIN sites s ON s.id=c.site_id
    JOIN visitors v ON v.id=c.visitor_id
    ${where}
    ORDER BY COALESCE(c.last_message_at,c.created_at) DESC
    LIMIT 300`, params);
  res.json({ conversations: rows });
});

app.get('/api/admin/presence', auth('admin'), async (_, res) => {
  try {
    res.json(await crispBridge.refreshRecentPresence());
  } catch (error) {
    res.status(error.statusCode || 502).json({ error: error.message || 'Crisp 在线状态同步失败' });
  }
});

app.get('/api/admin/conversations/:id/presence', auth('admin'), async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isSafeInteger(id) || id <= 0) return res.status(400).json({ error: '会话 ID 无效' });
    const presence = await crispBridge.refreshPresence(id);
    await emitConversationUpdate(id);
    res.json({ presence });
  } catch (error) {
    res.status(error.statusCode || 502).json({ error: error.message || 'Crisp 在线状态同步失败' });
  }
});

app.get('/api/admin/conversations/:id/messages', auth('admin'), async (req, res) => {
  const id = Number(req.params.id);
  const [rows] = await pool.execute('SELECT * FROM messages WHERE conversation_id=? ORDER BY id ASC LIMIT 1000', [id]);
  await pool.execute('UPDATE conversations SET unread_admin=0 WHERE id=?', [id]);
  await emitConversationUpdate(id);
  res.json({ messages: rows });
});

app.post('/api/admin/conversations/:id/messages', auth('admin'), async (req, res) => {
  try {
    const id = Number(req.params.id);
    const msg = await createMessage(id, 'agent', { content: req.body.content, messageType: 'text' });
    res.status(201).json({ message: msg });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.post('/api/admin/conversations/:id/upload', auth('admin'), upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: '请选择文件' });
  const id = Number(req.params.id);
  const isImage = req.file.mimetype.startsWith('image/');
  const fileUrl = `${await publicBaseUrl(req)}/uploads/${encodeURIComponent(req.file.filename)}`;
  const msg = await createMessage(id, 'agent', {
    messageType: isImage ? 'image' : 'file', fileUrl, fileName: req.file.originalname, fileSize: req.file.size
  });
  res.status(201).json({ message: msg });
});

app.patch('/api/admin/conversations/:id', auth('admin'), async (req, res) => {
  const id = Number(req.params.id);
  const status = req.body.status === 'closed' ? 'closed' : 'open';
  await pool.execute('UPDATE conversations SET status=? WHERE id=?', [status, id]);
  await emitConversationUpdate(id);
  res.json({ ok: true });
});

app.use('/uploads', express.static(uploadDir, { maxAge: '7d' }));
app.use('/widget', express.static(path.join(__dirname, '..', 'public', 'widget')));
app.use('/admin', express.static(path.join(__dirname, '..', 'public', 'admin')));
app.use('/demo', express.static(path.join(__dirname, '..', 'public', 'demo')));
app.get('/widget.js', (_, res) => res.sendFile(path.join(__dirname, '..', 'public', 'widget-loader.js')));
app.get('/', (_, res) => res.redirect('/admin/'));

io.use((socket, next) => {
  try {
    const token = socket.handshake.auth?.token;
    socket.authData = jwt.verify(token, JWT_SECRET);
    next();
  } catch { next(new Error('unauthorized')); }
});

io.on('connection', (socket) => {
  const a = socket.authData;
  if (a.role === 'admin') {
    socket.join('admins');
  } else if (a.role === 'visitor') {
    socket.join(`conversation:${a.conversationId}`);
    pool.execute('UPDATE visitors SET last_seen_at=NOW() WHERE site_id=? AND visitor_key=?', [a.siteId, a.visitorKey]).catch(()=>{});
    emitConversationUpdate(a.conversationId).catch(()=>{});
  }
  socket.on('conversation:join', async ({ conversationId }) => {
    const id = Number(conversationId);
    if (!id) return;
    if (await canAccessConversation(a, id)) socket.join(`conversation:${id}`);
  });
});

app.use((err, req, res, next) => {
  console.error(err);
  res.status(err.statusCode || 400).json({ error: err.message || '请求失败' });
});

async function start() {
  await ensureCoreSchema();
  await settingsStore.ensureSchema();
  await ensureKeywordReplySchema();
  await telegramBridge.ensureSchema();
  await crispBridge.ensureSchema();
  telegramBridge.startWorker();
  crispBridge.startWorker();
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`Support Chat running on port ${PORT}`);
  });
}

start().catch(error => {
  console.error('Support Chat startup failed:', error);
  process.exitCode = 1;
});
