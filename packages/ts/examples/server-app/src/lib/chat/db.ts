import { existsSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import type { Database } from '@delali/sirannon-db'

const CHAT_DB_KEY = Symbol.for('narsil-server-app-chat-db')
const g = globalThis as unknown as Record<symbol, Promise<Database> | undefined>

function chatDbPath(): string {
  const override = process.env.ASK_CHAT_DB_PATH
  if (override !== undefined && override.trim().length > 0) {
    return path.resolve(override.trim())
  }
  const dataDir = process.env.NARSIL_DATA_DIR
  const base =
    dataDir !== undefined && dataDir.trim().length > 0
      ? path.resolve(dataDir.trim())
      : path.resolve(process.cwd(), '.narsil-data')
  return path.join(base, 'chat.db')
}

async function initSchema(db: Database): Promise<void> {
  await db.execute(
    `CREATE TABLE IF NOT EXISTS threads (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      index_name TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`,
  )
  await db.execute(
    `CREATE TABLE IF NOT EXISTS messages (
      thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
      position INTEGER NOT NULL,
      msg_id TEXT NOT NULL,
      role TEXT NOT NULL,
      payload TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (thread_id, position)
    )`,
  )
  await db.execute('CREATE INDEX IF NOT EXISTS idx_threads_updated ON threads(updated_at DESC)')
}

async function openChatDb(): Promise<Database> {
  const dbPath = chatDbPath()
  const dir = path.dirname(dbPath)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  const [{ Sirannon }, { betterSqlite3 }] = await Promise.all([
    import('@delali/sirannon-db'),
    import('@delali/sirannon-db/driver/better-sqlite3'),
  ])
  const sirannon = new Sirannon({ driver: betterSqlite3() })
  const db = await sirannon.open('ask-chat', dbPath)
  await initSchema(db)
  return db
}

export function getChatDb(): Promise<Database> {
  const cached = g[CHAT_DB_KEY]
  if (cached) return cached
  const pending = openChatDb().catch(error => {
    g[CHAT_DB_KEY] = undefined
    throw error
  })
  g[CHAT_DB_KEY] = pending
  return pending
}
