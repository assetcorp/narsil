import type { UIMessage } from 'ai'
import { THREAD_ID_PATTERN } from '../chat/validation'
import type { AskUIMessage } from './types'
import { RETRIEVAL_MODES, type RetrievalMode } from './types'

export const MAX_QUESTION_CHARS = 4000
const MAX_MESSAGE_PARTS = 32
const MAX_HISTORY_MESSAGES = 12
const MAX_HISTORY_CHARS = 24000
const INDEX_NAME_PATTERN = /^[a-zA-Z0-9._-]{1,64}$/
const MESSAGE_ID_PATTERN = /^[a-zA-Z0-9._-]{1,64}$/

export type AskTrigger = 'submit-message' | 'regenerate-message'

export class AskRequestError extends Error {
  readonly status: number

  constructor(message: string, status = 400) {
    super(message)
    this.name = 'AskRequestError'
    this.status = status
  }
}

export interface AskRequest {
  threadId: string
  indexName: string
  mode: RetrievalMode
  webSearch: boolean
  trigger: AskTrigger
  messageId: string | undefined
  message: AskUIMessage | undefined
}

export function messageText(message: UIMessage): string {
  let text = ''
  for (const part of message.parts) {
    if (part.type === 'text') text += part.text
  }
  return text.trim()
}

function parseUserMessage(value: unknown): AskUIMessage {
  if (typeof value !== 'object' || value === null) {
    throw new AskRequestError('Field "message" must be the newest user message')
  }
  const { id, role, parts } = value as Record<string, unknown>
  if (typeof id !== 'string' || !MESSAGE_ID_PATTERN.test(id)) {
    throw new AskRequestError('The message needs an id')
  }
  if (role !== 'user') {
    throw new AskRequestError('The message role must be "user"')
  }
  if (!Array.isArray(parts) || parts.length === 0 || parts.length > MAX_MESSAGE_PARTS) {
    throw new AskRequestError(`The message needs 1 to ${MAX_MESSAGE_PARTS} parts`)
  }
  const textParts: Array<{ type: 'text'; text: string }> = []
  let totalChars = 0
  for (const part of parts) {
    if (typeof part !== 'object' || part === null) {
      throw new AskRequestError('Every message part must be an object')
    }
    const { type, text } = part as Record<string, unknown>
    if (type !== 'text' || typeof text !== 'string') {
      throw new AskRequestError('User messages support text parts only')
    }
    totalChars += text.length
    textParts.push({ type: 'text', text })
  }
  if (totalChars > MAX_QUESTION_CHARS) {
    throw new AskRequestError(`The question is longer than ${MAX_QUESTION_CHARS} characters`)
  }
  const message: AskUIMessage = { id, role: 'user', parts: textParts }
  if (messageText(message).length === 0) {
    throw new AskRequestError('The question is empty')
  }
  return message
}

export function parseAskRequest(body: unknown): AskRequest {
  if (typeof body !== 'object' || body === null) {
    throw new AskRequestError('The request body must be a JSON object')
  }
  const { indexName, mode, webSearch, threadId, trigger, messageId, message } = body as Record<string, unknown>

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
  if (trigger !== 'submit-message' && trigger !== 'regenerate-message') {
    throw new AskRequestError('Field "trigger" must be "submit-message" or "regenerate-message"')
  }
  if (messageId !== undefined && (typeof messageId !== 'string' || !MESSAGE_ID_PATTERN.test(messageId))) {
    throw new AskRequestError('Field "messageId" must identify a message')
  }

  if (trigger === 'submit-message') {
    return {
      threadId,
      indexName,
      mode: mode as RetrievalMode,
      webSearch: webSearch === true,
      trigger,
      messageId,
      message: parseUserMessage(message),
    }
  }
  if (message !== undefined) {
    throw new AskRequestError('Regeneration reuses the stored conversation; send no "message"')
  }
  return {
    threadId,
    indexName,
    mode: mode as RetrievalMode,
    webSearch: webSearch === true,
    trigger,
    messageId,
    message: undefined,
  }
}

export function boundHistory(messages: AskUIMessage[]): AskUIMessage[] {
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
