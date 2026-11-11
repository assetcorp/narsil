import type { AnyDocument } from '@delali/narsil'
import * as v from 'valibot'
import { writeThroughSync } from './device-sync'

const RELAY_CHANNEL_NAME = 'narsil-browser-demo-sync-writes'
const RELAY_TIMEOUT_MS = 15_000

const RelayRequestSchema = v.object({
  kind: v.literal('write'),
  requestId: v.string(),
  indexName: v.string(),
  documentId: v.string(),
  document: v.nullable(v.record(v.string(), v.unknown())),
})

const RelayReplySchema = v.object({
  kind: v.literal('reply'),
  requestId: v.string(),
  error: v.nullable(v.string()),
})

interface RelayRequest {
  kind: 'write'
  requestId: string
  indexName: string
  documentId: string
  document: AnyDocument | null
}

type RelayReply = v.InferOutput<typeof RelayReplySchema>

interface PendingRelay {
  resolve: () => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

const pending = new Map<string, PendingRelay>()
let channel: BroadcastChannel | null = null

async function answer(open: BroadcastChannel, request: RelayRequest): Promise<void> {
  try {
    const handled = await writeThroughSync(request.indexName, request.documentId, request.document)
    if (!handled) return
    open.postMessage({ kind: 'reply', requestId: request.requestId, error: null } satisfies RelayReply)
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err)
    open.postMessage({ kind: 'reply', requestId: request.requestId, error } satisfies RelayReply)
  }
}

function settle(reply: RelayReply): void {
  const waiting = pending.get(reply.requestId)
  if (waiting === undefined) return
  pending.delete(reply.requestId)
  clearTimeout(waiting.timer)
  if (reply.error === null) {
    waiting.resolve()
  } else {
    waiting.reject(new Error(reply.error))
  }
}

function relayChannel(): BroadcastChannel {
  if (channel !== null) return channel
  const open = new BroadcastChannel(RELAY_CHANNEL_NAME)
  open.onmessage = (event: MessageEvent<unknown>) => {
    const request = v.safeParse(RelayRequestSchema, event.data)
    if (request.success) {
      void answer(open, { ...request.output, document: request.output.document as AnyDocument | null })
      return
    }
    const reply = v.safeParse(RelayReplySchema, event.data)
    if (reply.success) settle(reply.output)
  }
  channel = open
  return open
}

export function listenForRelayedWrites(): void {
  relayChannel()
}

export function relayWrite(indexName: string, documentId: string, document: AnyDocument | null): Promise<void> {
  const open = relayChannel()
  const requestId = crypto.randomUUID()
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(requestId)
      reject(new Error(`The tab that syncs ${indexName} did not answer within ${RELAY_TIMEOUT_MS / 1000} seconds`))
    }, RELAY_TIMEOUT_MS)
    pending.set(requestId, { resolve, reject, timer })
    open.postMessage({ kind: 'write', requestId, indexName, documentId, document } satisfies RelayRequest)
  })
}
