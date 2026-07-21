CREATE TABLE threads (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  index_name TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE messages (
  thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  msg_id TEXT NOT NULL,
  role TEXT NOT NULL,
  payload TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (thread_id, position)
);

CREATE INDEX idx_threads_updated ON threads(updated_at DESC);
