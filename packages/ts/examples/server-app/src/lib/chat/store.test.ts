import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { AskUIMessage } from '../ask/types'
import { deleteThread, ensureThread, listThreads, loadThread, saveThreadMessages, setThreadTitle } from './store'

let tempDir: string

beforeAll(() => {
  tempDir = mkdtempSync(path.join(tmpdir(), 'ask-chat-store-'))
  process.env.ASK_CHAT_DB_PATH = path.join(tempDir, 'chat.db')
})

afterAll(() => {
  if (tempDir && existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true })
})

function userMessage(id: string, text: string): AskUIMessage {
  return { id, role: 'user', parts: [{ type: 'text', text }] }
}

function assistantMessage(id: string, text: string): AskUIMessage {
  return { id, role: 'assistant', parts: [{ type: 'text', text }] }
}

describe('chat store', () => {
  it('creates a thread and lists it', async () => {
    await ensureThread('thread-a', 'scifact', 'Effects of vitamin D', 1000)
    const threads = await listThreads()
    const created = threads.find(thread => thread.id === 'thread-a')
    expect(created).toBeDefined()
    expect(created?.title).toBe('Effects of vitamin D')
    expect(created?.indexName).toBe('scifact')
    expect(created?.messageCount).toBe(0)
  })

  it('keeps the original title when ensureThread runs again', async () => {
    await ensureThread('thread-a', 'scifact', 'A different provisional title', 2000)
    const thread = await loadThread('thread-a')
    expect(thread?.title).toBe('Effects of vitamin D')
  })

  it('persists and reloads messages in order', async () => {
    const messages = [
      userMessage('u1', 'Does vitamin D help bone health?'),
      assistantMessage('a1', 'The evidence is mixed.'),
    ]
    await saveThreadMessages('thread-a', 'scifact', messages, 3000)
    const thread = await loadThread('thread-a')
    expect(thread?.messageCount).toBe(2)
    expect(thread?.messages.map(message => message.id)).toEqual(['u1', 'a1'])
    expect(thread?.messages[1].role).toBe('assistant')
  })

  it('does not overwrite an existing title when saving messages', async () => {
    const thread = await loadThread('thread-a')
    expect(thread?.title).toBe('Effects of vitamin D')
  })

  it('replaces messages on the next save rather than appending', async () => {
    await saveThreadMessages('thread-a', 'scifact', [userMessage('u2', 'Follow-up question')], 4000)
    const thread = await loadThread('thread-a')
    expect(thread?.messages.map(message => message.id)).toEqual(['u2'])
  })

  it('updates the title', async () => {
    await setThreadTitle('thread-a', 'Vitamin D and bones')
    const thread = await loadThread('thread-a')
    expect(thread?.title).toBe('Vitamin D and bones')
  })

  it('orders threads by most recently updated', async () => {
    await ensureThread('thread-b', 'scifact', 'Older thread', 500)
    await ensureThread('thread-c', 'scifact', 'Newest thread', 9000)
    const ids = (await listThreads()).map(thread => thread.id)
    expect(ids.indexOf('thread-c')).toBeLessThan(ids.indexOf('thread-b'))
  })

  it('deletes a thread and its messages', async () => {
    await saveThreadMessages('thread-d', 'scifact', [userMessage('d1', 'Delete me')], 5000)
    await deleteThread('thread-d')
    expect(await loadThread('thread-d')).toBeNull()
    const threads = await listThreads()
    expect(threads.some(thread => thread.id === 'thread-d')).toBe(false)
  })
})
