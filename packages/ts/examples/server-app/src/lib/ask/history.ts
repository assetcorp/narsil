import { safeValidateUIMessages } from 'ai'
import { loadThread, saveTurn } from '../chat/store'
import { type AskRequest, AskRequestError, messageText } from './messages'
import { provisionalTitle } from './title'
import type { AskUIMessage } from './types'

export interface AskTurn {
  history: AskUIMessage[]
  storedCount: number
  keepCount: number
  turnMessages: AskUIMessage[]
  question: string
  firstTurn: boolean
}

async function loadStoredMessages(threadId: string): Promise<AskUIMessage[]> {
  try {
    const thread = await loadThread(threadId)
    return thread?.messages ?? []
  } catch {
    throw new AskRequestError('The stored conversation could not be read; start a new chat', 500)
  }
}

function requireKnownMessage(stored: AskUIMessage[], messageId: string): number {
  const index = stored.findIndex(message => message.id === messageId)
  if (index === -1) {
    throw new AskRequestError('The referenced message is not part of this conversation', 409)
  }
  return index
}

function rejectDuplicateId(kept: AskUIMessage[], message: AskUIMessage): void {
  if (kept.some(existing => existing.id === message.id)) {
    throw new AskRequestError('A message with this id is already part of the conversation', 409)
  }
}

function applyTrigger(stored: AskUIMessage[], request: AskRequest): { kept: AskUIMessage[]; appended: AskUIMessage[] } {
  if (request.trigger === 'submit-message') {
    const message = request.message
    if (!message) {
      throw new AskRequestError('Field "message" must be the newest user message')
    }
    if (request.messageId === undefined) {
      rejectDuplicateId(stored, message)
      return { kept: stored, appended: [message] }
    }
    const index = requireKnownMessage(stored, request.messageId)
    if (stored[index].role !== 'user') {
      throw new AskRequestError('Only user messages can be edited', 409)
    }
    const kept = stored.slice(0, index)
    rejectDuplicateId(kept, message)
    return { kept, appended: [message] }
  }
  if (request.messageId === undefined) {
    const last = stored[stored.length - 1]
    const kept = last && last.role === 'assistant' ? stored.slice(0, -1) : stored
    return { kept, appended: [] }
  }
  const index = requireKnownMessage(stored, request.messageId)
  const kept = stored[index].role === 'assistant' ? stored.slice(0, index) : stored.slice(0, index + 1)
  return { kept, appended: [] }
}

export async function reconstructTurn(request: AskRequest): Promise<AskTurn> {
  const stored = await loadStoredMessages(request.threadId)
  const { kept, appended } = applyTrigger(stored, request)
  const history = [...kept, ...appended]
  const last = history[history.length - 1]
  if (!last || last.role !== 'user') {
    throw new AskRequestError('There is no user question to answer', 409)
  }
  const question = messageText(last)
  if (question.length === 0) {
    throw new AskRequestError('The question is empty', 409)
  }
  const validated = await safeValidateUIMessages<AskUIMessage>({ messages: history })
  if (!validated.success) {
    throw new AskRequestError('The stored conversation could not be read; start a new chat', 500)
  }
  let userMessages = 0
  for (const message of validated.data) {
    if (message.role === 'user') userMessages++
  }
  return {
    history: validated.data,
    storedCount: stored.length,
    keepCount: kept.length,
    turnMessages: appended,
    question,
    firstTurn: userMessages === 1,
  }
}

export async function persistTurnStart(request: AskRequest, turn: AskTurn, now: number): Promise<void> {
  await saveTurn({
    threadId: request.threadId,
    indexName: request.indexName,
    title: provisionalTitle(turn.question),
    expectedCount: turn.storedCount,
    keepCount: turn.keepCount,
    messages: turn.turnMessages,
    now,
  })
}
