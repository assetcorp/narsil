import type { Database } from '@delali/sirannon-db'
import { chatMigrations } from './migrations'

const CONCURRENT_MIGRATION_RETRY_DELAY_MS = 250

function delay(ms: number): Promise<void> {
  return new Promise(resolve => {
    setTimeout(resolve, ms)
  })
}

export async function ensureChatSchema(db: Database): Promise<void> {
  const migrations = chatMigrations()
  try {
    await db.migrate(migrations)
  } catch {
    await delay(CONCURRENT_MIGRATION_RETRY_DELAY_MS)
    await db.migrate(migrations)
  }
}
