import { createFileRoute } from '@tanstack/react-router'

function plainTextErrorResponse(status: number, message: string): Response {
  return new Response(message, {
    status,
    headers: { 'content-type': 'text/plain; charset=utf-8' },
  })
}

const MAX_BODY_BYTES = 64 * 1024

async function readBoundedBody(request: Request, maxBytes: number): Promise<string | null> {
  const body = request.body
  if (!body) return ''
  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let totalBytes = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    totalBytes += value.byteLength
    if (totalBytes > maxBytes) {
      await reader.cancel()
      return null
    }
    chunks.push(value)
  }
  const joined = new Uint8Array(totalBytes)
  let offset = 0
  for (const chunk of chunks) {
    joined.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder().decode(joined)
}

export const Route = createFileRoute('/api/ask')({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const contentLength = Number(request.headers.get('content-length') ?? 0)
        if (contentLength > MAX_BODY_BYTES) {
          return plainTextErrorResponse(413, 'The request payload is too large.')
        }
        const bodyText = await readBoundedBody(request, MAX_BODY_BYTES)
        if (bodyText === null) {
          return plainTextErrorResponse(413, 'The request payload is too large.')
        }

        const [
          { AskRequestError, parseAskRequest },
          { readLlmConfig },
          { createAskResponse },
          { getBackend },
          { persistTurnStart, reconstructTurn },
          { ThreadConflictError },
        ] = await Promise.all([
          import('#/lib/ask/messages'),
          import('#/lib/ask/config'),
          import('#/lib/ask/answer'),
          import('#/lib/get-backend'),
          import('#/lib/ask/history'),
          import('#/lib/chat/store'),
        ])

        let parsed: ReturnType<typeof parseAskRequest>
        try {
          parsed = parseAskRequest(JSON.parse(bodyText))
        } catch (err) {
          if (err instanceof AskRequestError) return plainTextErrorResponse(err.status, err.message)
          return plainTextErrorResponse(400, 'The request body is not valid JSON')
        }

        let llm: ReturnType<typeof readLlmConfig>
        try {
          llm = readLlmConfig()
        } catch (err) {
          return plainTextErrorResponse(500, err instanceof Error ? err.message : 'The Ask configuration is invalid.')
        }
        if (!llm) {
          return plainTextErrorResponse(
            503,
            'No language model is configured. Set OPENAI_API_KEY (or ASK_LLM_API_KEY) in the app server environment and restart.',
          )
        }

        try {
          const turn = await reconstructTurn(parsed)
          await persistTurnStart(parsed, turn, Date.now())
          const backend = await getBackend()
          return createAskResponse(backend, llm, parsed, turn, request.signal)
        } catch (err) {
          if (err instanceof AskRequestError) return plainTextErrorResponse(err.status, err.message)
          if (err instanceof ThreadConflictError) return plainTextErrorResponse(409, err.message)
          return plainTextErrorResponse(500, 'The conversation could not be prepared. Check the app server logs.')
        }
      },
    },
  },
})
