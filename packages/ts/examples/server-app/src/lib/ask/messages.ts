import type { UIMessage } from 'ai'
import { RETRIEVAL_MODES, type RetrievalMode } from './types'

export const MAX_QUESTION_CHARS = 4000
const MAX_HISTORY_MESSAGES = 12
const MAX_HISTORY_CHARS = 24000
const INDEX_NAME_PATTERN = /^[a-zA-Z0-9._-]{1,64}$/
const THREAD_ID_PATTERN = /^[a-zA-Z0-9._-]{1,64}$/

export class AskRequestError extends Error {
  readonly status: number

  constructor(message: string, status = 400) {
    super(message)
    this.name = 'AskRequestError'
    this.status = status
  }
}

export interface AskRequest {
  messages: UIMessage[]
  indexName: string
  mode: RetrievalMode
  question: string
  webSearch: boolean
  threadId: string
}

export function messageText(message: UIMessage): string {
  let text = ''
  for (const part of message.parts) {
    if (part.type === 'text') text += part.text
  }
  return text.trim()
}

function isChatMessage(value: unknown): value is UIMessage {
  if (typeof value !== 'object' || value === null) return false
  const message = value as Record<string, unknown>
  return (
    (message.role === 'user' || message.role === 'assistant') &&
    typeof message.id === 'string' &&
    Array.isArray(message.parts)
  )
}

export function parseAskRequest(body: unknown): AskRequest {
  if (typeof body !== 'object' || body === null) {
    throw new AskRequestError('The request body must be a JSON object')
  }
  const { messages, indexName, mode, webSearch, threadId } = body as Record<string, unknown>

  if (typeof indexName !== 'string' || !INDEX_NAME_PATTERN.test(indexName)) {
    throw new AskRequestError('Field "indexName" must name an index')
  }
  if (typeof threadId !== 'string' || !THREAD_ID_PATTERN.test(threadId)) {
    throw new AskRequestError('Field "threadId" must identify the conversation')
  }
  if (typeof mode !== 'string' || !RETRIEVAL_MODES.includes(mode as RetrievalMode)) {
    throw new AskRequestError(`Field "mode" must be one of: ${RETRIEVAL_MODES.join(', ')}`)
  }
  if (webSearch !== undefined && typeof webSearch !== 'boolean') {
    throw new AskRequestError('Field "webSearch" must be a boolean')
  }
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new AskRequestError('Field "messages" must be a non-empty array')
  }
  if (!messages.every(isChatMessage)) {
    throw new AskRequestError('Every message needs an id, a user or assistant role, and a parts array')
  }

  const last = messages[messages.length - 1] as UIMessage
  if (last.role !== 'user') {
    throw new AskRequestError('The final message must be the user question')
  }
  const question = messageText(last)
  if (question.length === 0) {
    throw new AskRequestError('The question is empty')
  }
  if (question.length > MAX_QUESTION_CHARS) {
    throw new AskRequestError(`The question is longer than ${MAX_QUESTION_CHARS} characters`)
  }

  return {
    messages: messages as UIMessage[],
    indexName,
    mode: mode as RetrievalMode,
    question,
    webSearch: webSearch === true,
    threadId,
  }
}

export function boundHistory(messages: UIMessage[]): UIMessage[] {
  const recent = messages.slice(-MAX_HISTORY_MESSAGES)
  let total = 0
  for (const message of recent) total += messageText(message).length

  let start = 0
  while (start < recent.length - 1 && total > MAX_HISTORY_CHARS) {
    total -= messageText(recent[start]).length
    start++
  }
  return recent.slice(start)
}

export function isFollowUp(messages: UIMessage[]): boolean {
  let userMessages = 0
  for (const message of messages) {
    if (message.role === 'user') userMessages++
  }
  return userMessages > 1
}
