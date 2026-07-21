import type { AskUIMessage } from '../ask/types'
import { getChatDb } from './db'
import type { StoredThread, ThreadSummary } from './types'

const MAX_TITLE_CHARS = 120

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

function clampTitle(title: string): string {
  return title.slice(0, MAX_TITLE_CHARS)
}

function firstUserText(messages: AskUIMessage[]): string {
  for (const message of messages) {
    if (message.role !== 'user') continue
    let text = ''
    for (const part of message.parts) {
      if (part.type === 'text') text += part.text
    }
    const trimmed = text.trim()
    if (trimmed.length > 0) return trimmed
  }
  return 'New chat'
}

export async function ensureThread(id: string, indexName: string, title: string, now: number): Promise<void> {
  const db = await getChatDb()
  await db.execute(
    `INSERT INTO threads (id, title, index_name, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(id) DO NOTHING`,
    [id, clampTitle(title), indexName, now, now],
  )
}

export async function setThreadTitle(id: string, title: string): Promise<void> {
  const db = await getChatDb()
  await db.execute('UPDATE threads SET title = ? WHERE id = ?', [clampTitle(title), id])
}

export async function saveThreadMessages(
  id: string,
  indexName: string,
  messages: AskUIMessage[],
  now: number,
): Promise<void> {
  const db = await getChatDb()
  await db.transaction(async tx => {
    await tx.execute(
      `INSERT INTO threads (id, title, index_name, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET updated_at = excluded.updated_at, index_name = excluded.index_name`,
      [id, clampTitle(firstUserText(messages)), indexName, now, now],
    )
    await tx.execute('DELETE FROM messages WHERE thread_id = ?', [id])
    let position = 0
    for (const message of messages) {
      await tx.execute(
        `INSERT INTO messages (thread_id, position, msg_id, role, payload, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [id, position, message.id, message.role, JSON.stringify(message), now],
      )
      position++
    }
  })
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

export async function loadThread(id: string): Promise<StoredThread | null> {
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
  const messages = rows.map(row => JSON.parse(row.payload) as AskUIMessage)
  return { ...summary, messageCount: messages.length, messages }
}

export async function deleteThread(id: string): Promise<void> {
  const db = await getChatDb()
  await db.execute('DELETE FROM threads WHERE id = ?', [id])
}
