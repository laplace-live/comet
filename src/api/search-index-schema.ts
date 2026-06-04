// Current schema version. Bump when adding a migration step.
export const SCHEMA_VERSION = 1

// Full schema for the encrypted search index (spec section 7).
// External-content FTS5 over searchable_text only, kept in sync via triggers.
// trigram tokenizer (default detail) so snippet() can highlight CJK substring matches.
export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS schema_version (
  version    INTEGER NOT NULL,
  applied_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
  account_mid     INTEGER NOT NULL,
  talker_id       INTEGER NOT NULL,
  session_type    INTEGER NOT NULL,
  msg_seqno       TEXT    NOT NULL,
  msg_key         TEXT    NOT NULL,
  sender_uid      INTEGER,
  msg_type        INTEGER,
  msg_source      INTEGER,
  timestamp       INTEGER,
  msg_status      INTEGER,
  searchable_text TEXT,
  type_label      TEXT,
  raw_json        TEXT,
  PRIMARY KEY (account_mid, talker_id, session_type, msg_key)
);

CREATE INDEX IF NOT EXISTS idx_messages_conv_seqno
  ON messages (account_mid, talker_id, session_type, msg_seqno);

CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
  searchable_text,
  content='messages',
  content_rowid='rowid',
  tokenize='trigram'
);

CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts (rowid, searchable_text)
  VALUES (new.rowid, new.searchable_text);
END;

CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
  INSERT INTO messages_fts (messages_fts, rowid, searchable_text)
  VALUES ('delete', old.rowid, old.searchable_text);
END;

CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE ON messages BEGIN
  INSERT INTO messages_fts (messages_fts, rowid, searchable_text)
  VALUES ('delete', old.rowid, old.searchable_text);
  INSERT INTO messages_fts (rowid, searchable_text)
  VALUES (new.rowid, new.searchable_text);
END;

CREATE TABLE IF NOT EXISTS sessions (
  account_mid   INTEGER NOT NULL,
  talker_id     INTEGER NOT NULL,
  session_type  INTEGER NOT NULL,
  name          TEXT,
  group_name    TEXT,
  last_msg_text TEXT,
  session_ts    TEXT,
  unread_count  INTEGER,
  PRIMARY KEY (account_mid, talker_id, session_type)
);

CREATE TABLE IF NOT EXISTS users (
  account_mid INTEGER NOT NULL,
  mid         INTEGER NOT NULL,
  name        TEXT,
  face        TEXT,
  PRIMARY KEY (account_mid, mid)
);

CREATE TABLE IF NOT EXISTS account_cursors (
  account_mid            INTEGER PRIMARY KEY,
  session_end_ts         TEXT,
  session_has_more       INTEGER,
  newest_seen_session_ts TEXT,
  last_full_sweep_at     INTEGER
);

CREATE TABLE IF NOT EXISTS conv_cursors (
  account_mid     INTEGER NOT NULL,
  talker_id       INTEGER NOT NULL,
  session_type    INTEGER NOT NULL,
  oldest_seqno    TEXT,
  backfill_done   INTEGER,
  newest_seqno    TEXT,
  newest_msg_key  TEXT,
  last_indexed_at INTEGER,
  total_indexed   INTEGER,
  PRIMARY KEY (account_mid, talker_id, session_type)
);
`
