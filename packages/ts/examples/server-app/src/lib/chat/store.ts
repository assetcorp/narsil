import type { AskUIMessage } from '../ask/types'
import { getChatDb } from './db'
import { joinMessagePayloads, parseStoredMessages } from './serialization'
import type { SerializedThread, StoredThread, ThreadSummary } from './types'

const MAX_TITLE_CHARS = 120

export class ThreadConflictError extends Error {
  constructor(threadId: string) {
    super(`The conversation "${threadId}" changed while this turn was running`)
    this.name = 'ThreadConflictError'
  }
}

export interface SaveTurnParams {
  threadId: string
  indexName: string
  title: string
  expectedCount: number
  keepCount: number
  messages: AskUIMessage[]
  now: number
}

interface SummaryRow {
  id: string
  title: string
  indexName: string
  createdAt: number
  updatedAt: number
  messageCount: number
}

interface PayloadRow {
  payload: string
}

interface CountRow {
  count: number
}

function clampTitle(title: string): string {
  return title.slice(0, MAX_TITLE_CHARS)
}

export async function saveTurn(params: SaveTurnParams): Promise<void> {
  const { threadId, indexName, title, expectedCount, keepCount, messages, now } = params
  const db = await getChatDb()
  await db.transaction(async tx => {
    await tx.execute(
      `INSERT INTO threads (id, title, index_name, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET updated_at = excluded.updated_at, index_name = excluded.index_name`,
      [threadId, clampTitle(title), indexName, now, now],
    )
    const rows = await tx.query<CountRow>('SELECT COUNT(*) AS count FROM messages WHERE thread_id = ?', [threadId])
    if (rows[0].count !== expectedCount) {
      throw new ThreadConflictError(threadId)
    }
    if (keepCount < expectedCount) {
      await tx.execute('DELETE FROM messages WHERE thread_id = ? AND position >= ?', [threadId, keepCount])
    }
    if (messages.length > 0) {
      await tx.executeBatch(
        `INSERT INTO messages (thread_id, position, msg_id, role, payload, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        messages.map((message, offset) => [
          threadId,
          keepCount + offset,
          message.id,
          message.role,
          JSON.stringify(message),
          now,
        ]),
      )
    }
  })
}

export async function setThreadTitle(id: string, title: string): Promise<void> {
  const db = await getChatDb()
  await db.execute('UPDATE threads SET title = ? WHERE id = ?', [clampTitle(title), id])
}

export async function listThreads(limit = 100): Promise<ThreadSummary[]> {
  const db = await getChatDb()
  const rows = await db.query<SummaryRow>(
    `SELECT t.id AS id,
            t.title AS title,
            t.index_name AS indexName,
            t.created_at AS createdAt,
            t.updated_at AS updatedAt,
            (SELECT COUNT(*) FROM messages m WHERE m.thread_id = t.id) AS messageCount
     FROM threads t
     ORDER BY t.updated_at DESC
     LIMIT ?`,
    [limit],
  )
  return rows.map(row => ({ ...row }))
}

async function loadThreadRows(
  id: string,
): Promise<{ summary: Omit<SummaryRow, 'messageCount'>; payloads: string[] } | null> {
  const db = await getChatDb()
  const summary = await db.queryOne<Omit<SummaryRow, 'messageCount'>>(
    `SELECT id AS id,
            title AS title,
            index_name AS indexName,
            created_at AS createdAt,
            updated_at AS updatedAt
     FROM threads
     WHERE id = ?`,
    [id],
  )
  if (!summary) return null
  const rows = await db.query<PayloadRow>('SELECT payload FROM messages WHERE thread_id = ? ORDER BY position ASC', [
    id,
  ])
  return { summary, payloads: rows.map(row => row.payload) }
}

export async function loadThread(id: string): Promise<StoredThread | null> {
  const thread = await loadThreadRows(id)
  if (!thread) return null
  const messages = parseStoredMessages(joinMessagePayloads(thread.payloads))
  return { ...thread.summary, messageCount: messages.length, messages }
}

export async function loadThreadSerialized(id: string): Promise<SerializedThread | null> {
  const thread = await loadThreadRows(id)
  if (!thread) return null
  return {
    ...thread.summary,
    messageCount: thread.payloads.length,
    messagesJson: joinMessagePayloads(thread.payloads),
  }
}

export async function deleteThread(id: string): Promise<void> {
  const db = await getChatDb()
  await db.execute('DELETE FROM threads WHERE id = ?', [id])
}
