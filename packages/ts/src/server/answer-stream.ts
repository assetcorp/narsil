import { randomUUID } from 'node:crypto'
import { answerRefusalOf } from '../distribution/cluster-node/memory/answer-room'
import type { NarsilError } from '../errors'
import { encodeJson } from '../json-encoding'
import {
  RESPONSE_GROUP_BYTES,
  RESPONSE_GROUP_DOCUMENTS,
  RESPONSE_HEAP_BYTES_PER_ANSWER_BYTE,
  RESPONSE_MEMORY_WAIT_MAX_MS,
  RESPONSE_MEMORY_WAIT_POLL_MS,
} from './constants'
import { respondError } from './handler-utils'
import type { RouteContext } from './request'
import { sendEncodedJson, sendStream } from './response'

const JSON_HEADERS: Array<[string, string]> = [['Content-Type', 'application/json']]
const UTF8 = new TextEncoder()

interface AnswerItems {
  count: number
  open: string
  close: string
  encode(at: number): string | undefined
}

interface AnswerGroup {
  text: string
  encoded: number
  next: number
}

function itemsOf(collection: unknown): AnswerItems | null {
  if (Array.isArray(collection)) {
    return {
      count: collection.length,
      open: '[',
      close: ']',
      encode: at => {
        const text: string | undefined = encodeJson(collection[at])
        return text ?? 'null'
      },
    }
  }
  if (collection === null || typeof collection !== 'object' || ArrayBuffer.isView(collection)) return null
  const record = collection as Record<string, unknown>
  const keys = Object.keys(record)
  return {
    count: keys.length,
    open: '{',
    close: '}',
    encode: at => {
      const key = keys[at] ?? ''
      const text: string | undefined = encodeJson(record[key])
      return text === undefined ? undefined : `${JSON.stringify(key)}:${text}`
    },
  }
}

function groupFrom(items: AnswerItems, from: number): AnswerGroup {
  const parts: string[] = []
  let length = 0
  let at = from
  while (at < items.count && parts.length < RESPONSE_GROUP_DOCUMENTS && length < RESPONSE_GROUP_BYTES) {
    const part = items.encode(at)
    at++
    if (part === undefined) continue
    parts.push(part)
    length += part.length
  }
  return { text: parts.join(','), encoded: parts.length, next: at }
}

function answerBytesOf(text: string): number {
  return text.length * RESPONSE_HEAP_BYTES_PER_ANSWER_BYTE
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function waitForRoom(ctx: RouteContext, answerBytes: number, label: string, sentBytes: number): Promise<void> {
  const deadlineAt = performance.now() + RESPONSE_MEMORY_WAIT_MAX_MS
  for (;;) {
    const refusal: NarsilError | null = answerRefusalOf(answerBytes)
    if (refusal === null || ctx.abort.aborted) return
    if (performance.now() >= deadlineAt) {
      console.warn(
        `The server closed the connection part way through its answer to ${label} after sending ${sentBytes} bytes, because the next ${answerBytes} bytes found no room in memory for ${RESPONSE_MEMORY_WAIT_MAX_MS} ms:`,
        refusal.details,
      )
      throw refusal
    }
    await delay(RESPONSE_MEMORY_WAIT_POLL_MS)
  }
}

function respondWhole(ctx: RouteContext, answer: object): void {
  const payload: string | undefined = encodeJson(answer)
  const refusal = payload === undefined ? null : answerRefusalOf(answerBytesOf(payload))
  if (refusal !== null) {
    respondError(ctx, refusal)
    return
  }
  sendEncodedJson(ctx.res, payload, 200, ctx.abort)
}

export async function respondAnswer<T extends object>(
  ctx: RouteContext,
  answer: T,
  field: keyof T & string,
  label: string,
): Promise<void> {
  if (ctx.abort.aborted) return
  const items = itemsOf(answer[field])
  if (items === null || items.count <= RESPONSE_GROUP_DOCUMENTS) {
    respondWhole(ctx, answer)
    return
  }

  const marker = randomUUID()
  const envelope = encodeJson({ ...answer, [field]: marker })
  const quotedMarker = JSON.stringify(marker)
  const markerAt = envelope.indexOf(quotedMarker)
  const head = envelope.slice(0, markerAt) + items.open
  const tail = items.close + envelope.slice(markerAt + quotedMarker.length)

  let position = 0
  let anyEncoded = false
  let sentBytes = 0
  let finished = false
  const source = new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        if (finished) {
          controller.close()
          return
        }
        const first = position === 0
        const group = groupFrom(items, position)
        position = group.next
        let text = anyEncoded && group.encoded > 0 ? `,${group.text}` : group.text
        anyEncoded = anyEncoded || group.encoded > 0
        if (first) text = head + text
        if (position >= items.count) {
          text += tail
          finished = true
        }
        if (first) {
          const refusal = answerRefusalOf(answerBytesOf(text) + answerBytesOf(tail))
          if (refusal !== null) throw refusal
        } else {
          await waitForRoom(ctx, answerBytesOf(text), label, sentBytes)
        }
        const chunk = UTF8.encode(text)
        sentBytes += chunk.byteLength
        controller.enqueue(chunk)
      },
    },
    { highWaterMark: 0 },
  )

  try {
    await sendStream(ctx.res, ctx.abort, source, JSON_HEADERS)
  } catch (err) {
    respondError(ctx, err)
  }
}
