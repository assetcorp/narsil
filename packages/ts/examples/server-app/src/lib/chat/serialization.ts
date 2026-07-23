import type { AskUIMessage } from '../ask/types'

function isStoredMessage(value: unknown): value is AskUIMessage {
  if (typeof value !== 'object' || value === null) return false
  const message = value as Record<string, unknown>
  return (
    typeof message.id === 'string' &&
    (message.role === 'user' || message.role === 'assistant') &&
    Array.isArray(message.parts)
  )
}

export function parseStoredMessages(json: string): AskUIMessage[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    throw new Error('The stored conversation is not valid JSON')
  }
  if (!Array.isArray(parsed)) {
    throw new Error('The stored conversation must be an array of messages')
  }
  if (!parsed.every(isStoredMessage)) {
    throw new Error('The stored conversation contains a malformed message')
  }
  return parsed
}

export function joinMessagePayloads(payloads: string[]): string {
  return `[${payloads.join(',')}]`
}
