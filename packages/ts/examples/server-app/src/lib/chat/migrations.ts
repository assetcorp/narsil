import type { Migration } from '@delali/sirannon-db'

export const CHAT_MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'create_chat_schema',
    up: async tx => {
      await tx.execute(
        `CREATE TABLE threads (
          id TEXT PRIMARY KEY,
          title TEXT NOT NULL,
          index_name TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        )`,
      )
      await tx.execute(
        `CREATE TABLE messages (
          thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
          position INTEGER NOT NULL,
          msg_id TEXT NOT NULL,
          role TEXT NOT NULL,
          payload TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          PRIMARY KEY (thread_id, position)
        )`,
      )
      await tx.execute('CREATE INDEX idx_threads_updated ON threads(updated_at DESC)')
    },
    down: async tx => {
      await tx.execute('DROP TABLE IF EXISTS messages')
      await tx.execute('DROP TABLE IF EXISTS threads')
    },
  },
]
