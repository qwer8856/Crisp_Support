SET NAMES utf8mb4;

CREATE TABLE IF NOT EXISTS sites (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  site_key VARCHAR(64) NOT NULL,
  name VARCHAR(100) NOT NULL,
  agent_name VARCHAR(100) NOT NULL DEFAULT '在线客服',
  logo_url VARCHAR(500) NULL,
  welcome_text VARCHAR(500) NOT NULL DEFAULT '请问有什么可以帮您？',
  header_text VARCHAR(200) NOT NULL DEFAULT '有疑问吗？联系我们！',
  launcher_position ENUM('left','right') NOT NULL DEFAULT 'left',
  allowed_origins TEXT NULL,
  telegram_chat_id VARCHAR(64) NULL,
  integration_mode ENUM('native','crisp') NOT NULL DEFAULT 'crisp',
  crisp_website_id VARCHAR(64) NULL,
  crisp_token_identifier TEXT NULL,
  crisp_token_key TEXT NULL,
  crisp_webhook_secret TEXT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uk_sites_site_key (site_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

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
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS visitors (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  site_id BIGINT UNSIGNED NOT NULL,
  visitor_key VARCHAR(96) NOT NULL,
  display_name VARCHAR(120) NULL,
  email VARCHAR(190) NULL,
  external_user_id VARCHAR(191) NULL,
  identity_verified TINYINT(1) NOT NULL DEFAULT 0,
  metadata_json JSON NULL,
  context_json JSON NULL,
  current_url VARCHAR(1000) NULL,
  current_title VARCHAR(500) NULL,
  user_agent VARCHAR(1000) NULL,
  ip_address VARCHAR(64) NULL,
  last_seen_at TIMESTAMP NULL,
  is_online TINYINT(1) NULL DEFAULT NULL,
  presence_checked_at TIMESTAMP NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uk_visitors_site_key (site_id, visitor_key),
  KEY idx_visitors_last_seen (last_seen_at),
  CONSTRAINT fk_visitors_site FOREIGN KEY (site_id) REFERENCES sites(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS conversations (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  site_id BIGINT UNSIGNED NOT NULL,
  visitor_id BIGINT UNSIGNED NOT NULL,
  status ENUM('open','closed') NOT NULL DEFAULT 'open',
  unread_admin INT UNSIGNED NOT NULL DEFAULT 0,
  unread_visitor INT UNSIGNED NOT NULL DEFAULT 0,
  last_message_preview VARCHAR(500) NULL,
  last_message_at TIMESTAMP NULL,
  telegram_thread_id BIGINT NULL,
  crisp_session_id VARCHAR(128) NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_conversations_site_last (site_id, last_message_at),
  KEY idx_conversations_status (status),
  KEY idx_conversations_visitor (visitor_id),
  UNIQUE KEY uk_conversations_site_crisp_session (site_id, crisp_session_id),
  CONSTRAINT fk_conversations_site FOREIGN KEY (site_id) REFERENCES sites(id) ON DELETE CASCADE,
  CONSTRAINT fk_conversations_visitor FOREIGN KEY (visitor_id) REFERENCES visitors(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS messages (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  conversation_id BIGINT UNSIGNED NOT NULL,
  sender_type ENUM('visitor','agent','system') NOT NULL,
  message_type ENUM('text','file','image') NOT NULL DEFAULT 'text',
  content TEXT NULL,
  file_url VARCHAR(1000) NULL,
  file_name VARCHAR(500) NULL,
  file_size BIGINT UNSIGNED NULL,
  crisp_fingerprint BIGINT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_messages_conversation (conversation_id, id),
  UNIQUE KEY uk_messages_conversation_crisp_fingerprint (conversation_id, crisp_fingerprint),
  CONSTRAINT fk_messages_conversation FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

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
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

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
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS telegram_updates (
  update_id BIGINT NOT NULL,
  processed_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (update_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS system_settings (
  setting_key VARCHAR(64) NOT NULL,
  setting_value TEXT NOT NULL,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (setting_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
