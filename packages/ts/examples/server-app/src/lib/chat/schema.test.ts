import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { type Database, Sirannon } from '@delali/sirannon-db'
import { betterSqlite3 } from '@delali/sirannon-db/driver/better-sqlite3'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chatMigrations } from './migrations'
import { ensureChatSchema } from './schema'

let tempDir: string
const openDbs: Database[] = []

beforeAll(() => {
  tempDir = mkdtempSync(path.join(tmpdir(), 'ask-chat-schema-'))
})

afterAll(async () => {
  for (const db of openDbs) {
    await db.close()
  }
  if (tempDir && existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true })
})

async function openDatabase(dbPath: string): Promise<Database> {
  const sirannon = new Sirannon({ driver: betterSqlite3() })
  const db = await sirannon.open('ask-chat', dbPath)
  openDbs.push(db)
  return db
}

describe('chat migrations', () => {
  it('bundles every migration file into ordered units', () => {
    const migrations = chatMigrations()
    expect(migrations.length).toBeGreaterThanOrEqual(1)
    expect(migrations[0].version).toBe(1)
    expect(migrations[0].name).toBe('create_chat_schema')
    expect(typeof migrations[0].up).toBe('string')
    expect(typeof migrations[0].down).toBe('string')
    const versions = migrations.map(migration => migration.version)
    expect(versions).toEqual([...versions].sort((a, b) => a - b))
    expect(new Set(versions).size).toBe(versions.length)
  })
})

describe('ensureChatSchema', () => {
  it('creates the schema and skips already applied versions on the next run', async () => {
    const db = await openDatabase(path.join(tempDir, 'idempotent.db'))
    await ensureChatSchema(db)
    await ensureChatSchema(db)
    const result = await db.migrate(chatMigrations())
    expect(result.applied).toHaveLength(0)
    expect(result.skipped).toBe(chatMigrations().length)
    const tables = await db.query<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('threads', 'messages') ORDER BY name",
    )
    expect(tables.map(table => table.name)).toEqual(['messages', 'threads'])
  })

  it('survives two connections migrating the same database concurrently', async () => {
    const dbPath = path.join(tempDir, 'concurrent.db')
    const [first, second] = await Promise.all([openDatabase(dbPath), openDatabase(dbPath)])
    await Promise.all([ensureChatSchema(first), ensureChatSchema(second)])
    const recheck = await first.migrate(chatMigrations())
    expect(recheck.applied).toHaveLength(0)
    expect(recheck.skipped).toBe(chatMigrations().length)
    await second.execute(
      "INSERT INTO threads (id, title, index_name, created_at, updated_at) VALUES ('t1', 'Title', 'idx', 1, 1)",
    )
    const rows = await first.query<{ id: string }>('SELECT id FROM threads')
    expect(rows.map(row => row.id)).toEqual(['t1'])
  })
})
