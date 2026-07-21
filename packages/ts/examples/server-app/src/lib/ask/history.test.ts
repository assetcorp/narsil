import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { loadThread, saveTurn } from '../chat/store'
import { persistTurnStart, reconstructTurn } from './history'
import { type AskRequest, AskRequestError } from './messages'
import type { AskUIMessage } from './types'

let tempDir: string

beforeAll(() => {
  tempDir = mkdtempSync(path.join(tmpdir(), 'ask-chat-history-'))
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

function submitRequest(threadId: string, message: AskUIMessage, messageId?: string): AskRequest {
  return {
    threadId,
    indexName: 'scifact',
    mode: 'keyword',
    webSearch: false,
    trigger: 'submit-message',
    messageId,
    message,
  }
}

function regenerateRequest(threadId: string, messageId?: string): AskRequest {
  return {
    threadId,
    indexName: 'scifact',
    mode: 'keyword',
    webSearch: false,
    trigger: 'regenerate-message',
    messageId,
    message: undefined,
  }
}

async function seedThread(threadId: string, messages: AskUIMessage[]): Promise<void> {
  await saveTurn({
    threadId,
    indexName: 'scifact',
    title: 'Seeded thread',
    expectedCount: 0,
    keepCount: 0,
    messages,
    now: 1000,
  })
}

describe('reconstructTurn', () => {
  it('starts a new thread from the submitted message alone', async () => {
    const turn = await reconstructTurn(submitRequest('new-thread', userMessage('u1', 'What is aspirin?')))
    expect(turn.history.map(message => message.id)).toEqual(['u1'])
    expect(turn.storedCount).toBe(0)
    expect(turn.keepCount).toBe(0)
    expect(turn.turnMessages).toHaveLength(1)
    expect(turn.question).toBe('What is aspirin?')
    expect(turn.firstTurn).toBe(true)
  })

  it('appends a follow-up to the stored history', async () => {
    await seedThread('follow-up', [userMessage('u1', 'First question'), assistantMessage('a1', 'First answer')])
    const turn = await reconstructTurn(submitRequest('follow-up', userMessage('u2', 'And a follow-up?')))
    expect(turn.history.map(message => message.id)).toEqual(['u1', 'a1', 'u2'])
    expect(turn.storedCount).toBe(2)
    expect(turn.keepCount).toBe(2)
    expect(turn.firstTurn).toBe(false)
  })

  it('rejects a submitted message whose id is already stored', async () => {
    await seedThread('duplicate-id', [userMessage('u1', 'First question'), assistantMessage('a1', 'First answer')])
    await expect(reconstructTurn(submitRequest('duplicate-id', userMessage('u1', 'Again')))).rejects.toMatchObject({
      name: 'AskRequestError',
      status: 409,
    })
  })

  it('replaces an edited message and drops everything after it', async () => {
    await seedThread('edited', [
      userMessage('u1', 'First question'),
      assistantMessage('a1', 'First answer'),
      userMessage('u2', 'Second question'),
      assistantMessage('a2', 'Second answer'),
    ])
    const turn = await reconstructTurn(submitRequest('edited', userMessage('u1', 'Rephrased question'), 'u1'))
    expect(turn.history.map(message => message.id)).toEqual(['u1'])
    expect(turn.question).toBe('Rephrased question')
    expect(turn.storedCount).toBe(4)
    expect(turn.keepCount).toBe(0)
  })

  it('rejects editing an assistant message', async () => {
    await seedThread('edit-assistant', [userMessage('u1', 'Question'), assistantMessage('a1', 'Answer')])
    await expect(
      reconstructTurn(submitRequest('edit-assistant', userMessage('a1', 'Rewrite'), 'a1')),
    ).rejects.toMatchObject({ name: 'AskRequestError', status: 409 })
  })

  it('rejects a messageId that is not part of the thread', async () => {
    await seedThread('unknown-target', [userMessage('u1', 'Question')])
    await expect(
      reconstructTurn(submitRequest('unknown-target', userMessage('u9', 'Edit'), 'missing')),
    ).rejects.toMatchObject({ name: 'AskRequestError', status: 409 })
  })

  it('drops the trailing assistant answer when regenerating without a messageId', async () => {
    await seedThread('regen-last', [userMessage('u1', 'Question'), assistantMessage('a1', 'Answer')])
    const turn = await reconstructTurn(regenerateRequest('regen-last'))
    expect(turn.history.map(message => message.id)).toEqual(['u1'])
    expect(turn.keepCount).toBe(1)
    expect(turn.turnMessages).toHaveLength(0)
    expect(turn.question).toBe('Question')
  })

  it('truncates from the targeted assistant message when regenerating', async () => {
    await seedThread('regen-target', [
      userMessage('u1', 'First question'),
      assistantMessage('a1', 'First answer'),
      userMessage('u2', 'Second question'),
      assistantMessage('a2', 'Second answer'),
    ])
    const turn = await reconstructTurn(regenerateRequest('regen-target', 'a1'))
    expect(turn.history.map(message => message.id)).toEqual(['u1'])
    expect(turn.keepCount).toBe(1)
  })

  it('keeps history through a targeted user message when regenerating', async () => {
    await seedThread('regen-user', [
      userMessage('u1', 'First question'),
      assistantMessage('a1', 'First answer'),
      userMessage('u2', 'Second question'),
      assistantMessage('a2', 'Second answer'),
    ])
    const turn = await reconstructTurn(regenerateRequest('regen-user', 'u2'))
    expect(turn.history.map(message => message.id)).toEqual(['u1', 'a1', 'u2'])
    expect(turn.keepCount).toBe(3)
  })

  it('rejects regeneration when the thread has no user question', async () => {
    await expect(reconstructTurn(regenerateRequest('empty-thread'))).rejects.toBeInstanceOf(AskRequestError)
  })
})

describe('persistTurnStart', () => {
  it('stores the submitted message so a failed answer keeps the question', async () => {
    const request = submitRequest('persisted-start', userMessage('u1', 'Does aspirin lower risk?'))
    const turn = await reconstructTurn(request)
    await persistTurnStart(request, turn, 2000)
    const thread = await loadThread('persisted-start')
    expect(thread?.messages.map(message => message.id)).toEqual(['u1'])
    expect(thread?.title).toBe('Does aspirin lower risk?')
  })

  it('applies the truncation of an edit before the answer streams', async () => {
    await seedThread('persisted-edit', [
      userMessage('u1', 'First question'),
      assistantMessage('a1', 'First answer'),
      userMessage('u2', 'Second question'),
      assistantMessage('a2', 'Second answer'),
    ])
    const request = submitRequest('persisted-edit', userMessage('u2', 'Second question, sharper'), 'u2')
    const turn = await reconstructTurn(request)
    await persistTurnStart(request, turn, 3000)
    const thread = await loadThread('persisted-edit')
    expect(thread?.messages.map(message => message.id)).toEqual(['u1', 'a1', 'u2'])
    expect(thread?.messages[2].parts).toEqual([{ type: 'text', text: 'Second question, sharper' }])
  })

  it('removes the regenerated answer from storage', async () => {
    await seedThread('persisted-regen', [userMessage('u1', 'Question'), assistantMessage('a1', 'Answer')])
    const request = regenerateRequest('persisted-regen')
    const turn = await reconstructTurn(request)
    await persistTurnStart(request, turn, 4000)
    const thread = await loadThread('persisted-regen')
    expect(thread?.messages.map(message => message.id)).toEqual(['u1'])
  })
})
