-- Generated from the checksum-locked aria2 1.37.0-motrix.24 with synthetic credentials.
PRAGMA foreign_keys=OFF;
BEGIN TRANSACTION;
CREATE TABLE download_history (  id               INTEGER PRIMARY KEY AUTOINCREMENT,  gid              TEXT    NOT NULL,  status           TEXT    NOT NULL,  result_code      INTEGER NOT NULL,  result_message   TEXT    NOT NULL DEFAULT '',  total_length     INTEGER NOT NULL,  completed_length INTEGER NOT NULL,  upload_length    INTEGER NOT NULL DEFAULT 0,  num_pieces       INTEGER NOT NULL DEFAULT 0,  piece_length     INTEGER NOT NULL DEFAULT 0,  bitfield         BLOB,  info_hash        BLOB,  dir              TEXT    NOT NULL DEFAULT '',  belongs_to       TEXT,  following        TEXT,  followed_by      TEXT,  in_memory        INTEGER NOT NULL DEFAULT 0,  serialized       TEXT    NOT NULL DEFAULT '',  metadata_uri     TEXT,  bt_name          TEXT,  bt_announce_list TEXT,  bt_comment       TEXT,  bt_creation_date INTEGER,  bt_mode          TEXT,  bt_is_private    INTEGER NOT NULL DEFAULT 0,  bt_local_path    TEXT,  finished_at      INTEGER NOT NULL);
CREATE TABLE download_history_file_uris (  history_id  INTEGER NOT NULL,  file_index  INTEGER NOT NULL,  uri         TEXT    NOT NULL,  status      TEXT    NOT NULL,  PRIMARY KEY (history_id, file_index, uri),  FOREIGN KEY (history_id) REFERENCES download_history(id) ON DELETE CASCADE);
CREATE TABLE download_history_files (  history_id  INTEGER NOT NULL,  file_index  INTEGER NOT NULL,  path        TEXT    NOT NULL,  length      INTEGER NOT NULL,  selected    INTEGER NOT NULL DEFAULT 1,  PRIMARY KEY (history_id, file_index),  FOREIGN KEY (history_id) REFERENCES download_history(id) ON DELETE CASCADE);
CREATE TABLE legacy_checkpoint_file ( token TEXT NOT NULL REFERENCES legacy_checkpoint_import(token), path TEXT NOT NULL UNIQUE, device TEXT NOT NULL, inode TEXT NOT NULL, size TEXT NOT NULL, mtime_ns TEXT NOT NULL, ctime_ns TEXT NOT NULL, logical_offset INTEGER NOT NULL, logical_length INTEGER NOT NULL, PRIMARY KEY(token,path));
CREATE TABLE legacy_checkpoint_import ( token TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, gid TEXT NOT NULL, target_path TEXT NOT NULL UNIQUE, control_digest TEXT NOT NULL, progress_digest BLOB NOT NULL, consumed INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
CREATE TABLE legacy_torrent_metadata ( token TEXT PRIMARY KEY REFERENCES legacy_checkpoint_import(token), gid TEXT NOT NULL UNIQUE, metadata_path TEXT NOT NULL, metadata_digest TEXT NOT NULL, device TEXT NOT NULL, inode TEXT NOT NULL, size TEXT NOT NULL, mtime_ns TEXT NOT NULL, ctime_ns TEXT NOT NULL, invalidated INTEGER NOT NULL DEFAULT 0);
CREATE TABLE meta (  key   TEXT PRIMARY KEY,  value TEXT NOT NULL);
INSERT INTO "meta" VALUES('schema_version','6');
INSERT INTO "meta" VALUES('last_clean_shutdown','0');
INSERT INTO "meta" VALUES('aria2_version','1.37.0-motrix.24');
INSERT INTO "meta" VALUES('created_at','1794460186936');
CREATE TABLE task (  gid             TEXT    PRIMARY KEY,  state           TEXT    NOT NULL,  serialized      TEXT    NOT NULL,  belongs_to      TEXT,  following       TEXT,  followed_by     TEXT,  metadata_uri    TEXT,  bt_local_path   TEXT,  queue_position  INTEGER NOT NULL,  digest          BLOB    NOT NULL,  created_at      INTEGER NOT NULL,  updated_at      INTEGER NOT NULL);
INSERT INTO "task" VALUES('{{GID}}','paused','{{SOURCE_URI}}	
 gid={{GID}}
 pause=true
 dir={{DOWNLOAD_DIR}}
 out=legacy.bin
 require-task-cookies=true
 http-resume-context=true
 header=Authorization: Bearer fixture-only
 bt-enable-lpd=false
',NULL,NULL,NULL,NULL,NULL,0,X'F784AED6284BF01C4AB52C0B38A668D13E8484B7',1794460187011,1794460188016);
CREATE TABLE task_cookie (  gid                     TEXT    NOT NULL,  name                    TEXT    NOT NULL,  value                   TEXT    NOT NULL,  domain                  TEXT    NOT NULL,  path                    TEXT    NOT NULL,  host_only               INTEGER NOT NULL,  secure                  INTEGER NOT NULL,  http_only               INTEGER NOT NULL,  persistent              INTEGER NOT NULL,  expires_at_unix_s       INTEGER NOT NULL,  creation_time_unix_s    INTEGER NOT NULL,  last_access_time_unix_s INTEGER NOT NULL,  PRIMARY KEY (gid, name, domain, path),  FOREIGN KEY (gid) REFERENCES task_cookie_context(gid)    ON DELETE CASCADE);
INSERT INTO "task_cookie" VALUES('{{GID}}','auth','fixture-cookie','127.0.0.1','/',1,0,0,0,0,1794460187,1794460187);
CREATE TABLE task_cookie_context (  gid        TEXT    PRIMARY KEY,  updated_at INTEGER NOT NULL,  FOREIGN KEY (gid) REFERENCES task(gid) ON DELETE CASCADE);
INSERT INTO "task_cookie_context" VALUES('{{GID}}',1794460187011);
CREATE TABLE task_http_context ( gid TEXT PRIMARY KEY REFERENCES task(gid) ON DELETE CASCADE, source_hash TEXT NOT NULL, resource_hash TEXT NOT NULL, output_path TEXT NOT NULL, validator_kind TEXT NOT NULL, validator TEXT NOT NULL, total_length INTEGER NOT NULL);
CREATE TABLE "task_progress" (  gid              TEXT    NOT NULL,  out_path         TEXT,  ctrl_version     INTEGER NOT NULL DEFAULT 1,  is_torrent       INTEGER NOT NULL DEFAULT 0,  info_hash        BLOB,  piece_length     INTEGER NOT NULL,  total_length     INTEGER NOT NULL,  upload_length    INTEGER NOT NULL DEFAULT 0,  bitfield         BLOB    NOT NULL,  in_flight_blob   BLOB    NOT NULL DEFAULT X'',  digest           BLOB    NOT NULL,  updated_at       INTEGER NOT NULL);
CREATE INDEX idx_task_state          ON task(state);
CREATE INDEX idx_task_queue_position ON task(queue_position);
CREATE INDEX idx_history_finished_at ON download_history(finished_at DESC);
CREATE INDEX idx_history_status      ON download_history(status, finished_at DESC);
CREATE INDEX idx_history_gid         ON download_history(gid);
CREATE INDEX idx_history_info_hash   ON download_history(info_hash) WHERE info_hash IS NOT NULL;
CREATE INDEX idx_history_files_path ON download_history_files(path);
CREATE INDEX idx_history_file_uris_uri ON download_history_file_uris(uri);
CREATE INDEX idx_task_cookie_expiry ON task_cookie(gid, persistent, expires_at_unix_s);
CREATE UNIQUE INDEX idx_task_progress_out_path ON task_progress(out_path);
CREATE INDEX idx_task_progress_gid ON task_progress(gid);
DELETE FROM "sqlite_sequence";
COMMIT;
PRAGMA user_version=6;
PRAGMA foreign_keys=ON;
