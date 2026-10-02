CREATE TABLE sessions (
  session_id TEXT PRIMARY KEY,
  username TEXT NOT NULL,
  started_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  skill INTEGER NOT NULL,
  last_map TEXT NULL,
  health INTEGER NULL,
  armor INTEGER NULL,
  weapon TEXT NULL,
  ammo INTEGER NULL
);
CREATE INDEX idx_sessions_user ON sessions (username, started_at);
CREATE TABLE levels (
  level_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  map TEXT NOT NULL,
  episode INTEGER NOT NULL,
  map_number INTEGER NOT NULL,
  attempt INTEGER NOT NULL,
  skill INTEGER NOT NULL,
  started_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT NULL,
  time_tics INTEGER NOT NULL DEFAULT 0,
  par_tics INTEGER NULL,
  kills INTEGER NOT NULL DEFAULT 0,
  total_kills INTEGER NOT NULL DEFAULT 0,
  items INTEGER NOT NULL DEFAULT 0,
  total_items INTEGER NOT NULL DEFAULT 0,
  secrets INTEGER NOT NULL DEFAULT 0,
  total_secrets INTEGER NOT NULL DEFAULT 0,
  deaths INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_levels_session ON levels (session_id, started_at);
CREATE TABLE deaths (
  death_id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  level_id TEXT NULL,
  map TEXT NOT NULL,
  died_at TEXT NOT NULL,
  time_tics INTEGER NOT NULL,
  kills INTEGER NOT NULL,
  weapon TEXT NULL
);
CREATE INDEX idx_deaths_session ON deaths (session_id);
CREATE TABLE snapshots (
  snapshot_id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  map TEXT NOT NULL,
  taken_at TEXT NOT NULL,
  time_tics INTEGER NOT NULL,
  health INTEGER NOT NULL,
  armor INTEGER NOT NULL,
  weapon TEXT NULL,
  ammo INTEGER NOT NULL,
  kills INTEGER NOT NULL,
  items INTEGER NOT NULL,
  secrets INTEGER NOT NULL
);
CREATE INDEX idx_snapshots_session ON snapshots (session_id, snapshot_id);
CREATE TABLE IF NOT EXISTS profile (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  player_id TEXT NOT NULL,
  name TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS friends (
  player_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  card_at TEXT NOT NULL,
  imported_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS friend_bests (
  player_id TEXT NOT NULL,
  map TEXT NOT NULL,
  skill INTEGER NOT NULL,
  best_tics INTEGER NULL,
  par_tics INTEGER NULL,
  kills INTEGER NOT NULL,
  total_kills INTEGER NOT NULL,
  items INTEGER NOT NULL,
  total_items INTEGER NOT NULL,
  secrets INTEGER NOT NULL,
  total_secrets INTEGER NOT NULL,
  deaths INTEGER NOT NULL,
  runs INTEGER NOT NULL,
  PRIMARY KEY (player_id, map, skill)
);
