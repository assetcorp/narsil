import { createFileRoute } from '@tanstack/react-router'

const HEARTBEAT_INTERVAL_MS = 15_000

const STREAM_HEADERS = {
  'content-type': 'text/event-stream',
  'cache-control': 'no-cache, no-transform',
  connection: 'keep-alive',
}

function openStream(request: Request): Response {
  const encoder = new TextEncoder()
  let unsubscribe: (() => void) | null = null
  let heartbeat: ReturnType<typeof setInterval> | null = null
  let closed = false

  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      function write(chunk: string): void {
        if (closed) return
        controller.enqueue(encoder.encode(chunk))
      }

      function close(): void {
        if (closed) return
        closed = true
        if (heartbeat !== null) clearInterval(heartbeat)
        if (unsubscribe !== null) unsubscribe()
        controller.close()
      }

      request.signal.addEventListener('abort', close)

      try {
        const { subscribe } = await import('../../lib/cluster-observer')
        unsubscribe = await subscribe(snapshot => {
          write(`data: ${JSON.stringify(snapshot)}\n\n`)
        })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        write(`event: observer-error\ndata: ${JSON.stringify({ message })}\n\n`)
        close()
        return
      }

      if (closed) {
        unsubscribe()
        return
      }

      heartbeat = setInterval(() => {
        write(': keep-alive\n\n')
      }, HEARTBEAT_INTERVAL_MS)
    },

    cancel() {
      closed = true
      if (heartbeat !== null) clearInterval(heartbeat)
      if (unsubscribe !== null) unsubscribe()
    },
  })

  return new Response(body, { headers: STREAM_HEADERS })
}

export const Route = createFileRoute('/api/cluster-stream')({
  server: {
    handlers: {
      GET: ({ request }) => openStream(request),
    },
  },
})
