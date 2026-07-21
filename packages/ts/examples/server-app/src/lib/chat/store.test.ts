import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { AskUIMessage } from '../ask/types'
import { parseStoredMessages } from './serialization'
import {
  deleteThread,
  listThreads,
  loadThread,
  loadThreadSerialized,
  saveTurn,
  setThreadTitle,
  ThreadConflictError,
} from './store'

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

function turn(threadId: string, expectedCount: number, keepCount: number, messages: AskUIMessage[], now: number) {
  return saveTurn({
    threadId,
    indexName: 'scifact',
    title: 'Effects of vitamin D',
    expectedCount,
    keepCount,
    messages,
    now,
  })
}

describe('chat store', () => {
  it('creates a thread when the first user message is saved', async () => {
    await turn('thread-a', 0, 0, [userMessage('u1', 'Does vitamin D help bone health?')], 1000)
    const threads = await listThreads()
    const created = threads.find(thread => thread.id === 'thread-a')
    expect(created?.title).toBe('Effects of vitamin D')
    expect(created?.indexName).toBe('scifact')
    expect(created?.messageCount).toBe(1)
  })

  it('appends the assistant answer without rewriting earlier rows', async () => {
    await turn('thread-a', 1, 1, [assistantMessage('a1', 'The evidence is mixed.')], 2000)
    const thread = await loadThread('thread-a')
    expect(thread?.messages.map(message => message.id)).toEqual(['u1', 'a1'])
    expect(thread?.messageCount).toBe(2)
  })

  it('keeps the original title on later saves', async () => {
    await saveTurn({
      threadId: 'thread-a',
      indexName: 'scifact',
      title: 'A different provisional title',
      expectedCount: 2,
      keepCount: 2,
      messages: [userMessage('u2', 'Follow-up question')],
      now: 3000,
    })
    const thread = await loadThread('thread-a')
    expect(thread?.title).toBe('Effects of vitamin D')
    expect(thread?.updatedAt).toBe(3000)
  })

  it('rejects a save when the stored message count no longer matches', async () => {
    await expect(turn('thread-a', 1, 1, [assistantMessage('a9', 'stale')], 4000)).rejects.toBeInstanceOf(
      ThreadConflictError,
    )
    const thread = await loadThread('thread-a')
    expect(thread?.messages.map(message => message.id)).toEqual(['u1', 'a1', 'u2'])
  })

  it('truncates the tail and replaces an edited message', async () => {
    await turn('thread-a', 3, 1, [userMessage('u1-edited', 'Does vitamin D reduce fractures?')], 5000)
    const thread = await loadThread('thread-a')
    expect(thread?.messages.map(message => message.id)).toEqual(['u1', 'u1-edited'])
  })

  it('truncates without appending when a turn is regenerated', async () => {
    await turn('thread-a', 2, 1, [], 6000)
    const thread = await loadThread('thread-a')
    expect(thread?.messages.map(message => message.id)).toEqual(['u1'])
  })

  it('updates the title', async () => {
    await setThreadTitle('thread-a', 'Vitamin D and bones')
    const thread = await loadThread('thread-a')
    expect(thread?.title).toBe('Vitamin D and bones')
  })

  it('serializes messages into JSON that parses back to the stored thread', async () => {
    const serialized = await loadThreadSerialized('thread-a')
    expect(serialized?.messageCount).toBe(1)
    const parsed = parseStoredMessages(serialized?.messagesJson ?? '')
    expect(parsed).toEqual((await loadThread('thread-a'))?.messages)
  })

  it('returns null for an unknown thread', async () => {
    expect(await loadThread('missing-thread')).toBeNull()
    expect(await loadThreadSerialized('missing-thread')).toBeNull()
  })

  it('orders threads by most recently updated', async () => {
    await turn('thread-b', 0, 0, [userMessage('b1', 'Older thread')], 500)
    await turn('thread-c', 0, 0, [userMessage('c1', 'Newest thread')], 9000)
    const ids = (await listThreads()).map(thread => thread.id)
    expect(ids.indexOf('thread-c')).toBeLessThan(ids.indexOf('thread-b'))
  })

  it('deletes a thread and its messages', async () => {
    await turn('thread-d', 0, 0, [userMessage('d1', 'Delete me')], 5000)
    await deleteThread('thread-d')
    expect(await loadThread('thread-d')).toBeNull()
    const threads = await listThreads()
    expect(threads.some(thread => thread.id === 'thread-d')).toBe(false)
  })
})
