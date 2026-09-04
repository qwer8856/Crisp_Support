const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const SETTING_KEYS = new Set([
  'public_base_url',
  'telegram_bot_token',
  'telegram_webhook_secret',
  'visitor_identity_secret'
]);
const SECRET_KEYS = new Set([
  'telegram_bot_token',
  'telegram_webhook_secret',
  'visitor_identity_secret'
]);

function createSettingsStore({ pool, dataDir }) {
  let encryptionKey = null;

  async function ensureKey() {
    if (encryptionKey) return encryptionKey;
    await fs.promises.mkdir(dataDir, { recursive: true });
    const keyPath = path.join(dataDir, 'settings.key');
    try {
      encryptionKey = await fs.promises.readFile(keyPath);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const generated = crypto.randomBytes(32);
      try {
        await fs.promises.writeFile(keyPath, generated, { flag: 'wx', mode: 0o600 });
        encryptionKey = generated;
      } catch (writeError) {
        if (writeError.code !== 'EEXIST') throw writeError;
        encryptionKey = await fs.promises.readFile(keyPath);
      }
    }
    if (encryptionKey.length !== 32) throw new Error('配置加密密钥格式无效');
    return encryptionKey;
  }

  async function encrypt(value) {
    if (!value) return '';
    const key = await ensureKey();
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `enc:v1:${iv.toString('base64url')}:${tag.toString('base64url')}:${ciphertext.toString('base64url')}`;
  }

  async function decrypt(value) {
    if (!value || !value.startsWith('enc:v1:')) return value || '';
    const [, , ivValue, tagValue, ciphertextValue] = value.split(':');
    const key = await ensureKey();
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivValue, 'base64url'));
    decipher.setAuthTag(Buffer.from(tagValue, 'base64url'));
    return Buffer.concat([
      decipher.update(Buffer.from(ciphertextValue, 'base64url')),
      decipher.final()
    ]).toString('utf8');
  }

  async function ensureSchema() {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS system_settings (
        setting_key VARCHAR(64) NOT NULL,
        setting_value TEXT NOT NULL,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (setting_key)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    await ensureKey();
  }

  async function getAll() {
    const settings = {
      publicBaseUrl: '',
      telegramBotToken: '',
      telegramWebhookSecret: '',
      visitorIdentitySecret: ''
    };
    const [rows] = await pool.query('SELECT setting_key, setting_value FROM system_settings');
    for (const row of rows) {
      if (!SETTING_KEYS.has(row.setting_key)) continue;
      const value = SECRET_KEYS.has(row.setting_key)
        ? await decrypt(row.setting_value)
        : row.setting_value;
      if (row.setting_key === 'public_base_url') settings.publicBaseUrl = value;
      if (row.setting_key === 'telegram_bot_token') settings.telegramBotToken = value;
      if (row.setting_key === 'telegram_webhook_secret') settings.telegramWebhookSecret = value;
      if (row.setting_key === 'visitor_identity_secret') settings.visitorIdentitySecret = value;
    }
    return settings;
  }

  async function setMany(values) {
    const entries = [];
    for (const [key, rawValue] of Object.entries(values)) {
      if (!SETTING_KEYS.has(key)) continue;
      const value = String(rawValue || '');
      entries.push([key, SECRET_KEYS.has(key) ? await encrypt(value) : value]);
    }
    if (!entries.length) return;
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      for (const [key, value] of entries) {
        await connection.execute(`
          INSERT INTO system_settings(setting_key, setting_value) VALUES(?,?)
          ON DUPLICATE KEY UPDATE setting_value=VALUES(setting_value)`, [key, value]);
      }
      await connection.commit();
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }

  return { decrypt, encrypt, ensureSchema, getAll, setMany };
}

module.exports = { createSettingsStore };
