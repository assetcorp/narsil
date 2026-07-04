import { createFileRoute } from '@tanstack/react-router'

/* The chat client surfaces a non-OK response body verbatim as the error
 * message, so errors leave here as plain text, not JSON. */
function errorResponse(status: number, message: string): Response {
  return new Response(message, {
    status,
    headers: { 'content-type': 'text/plain; charset=utf-8' },
  })
}

const MAX_BODY_BYTES = 1024 * 1024

export const Route = createFileRoute('/api/ask')({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const contentLength = Number(request.headers.get('content-length') ?? 0)
        if (contentLength > MAX_BODY_BYTES) {
          return errorResponse(413, 'The conversation payload is too large.')
        }

        const [{ AskRequestError, parseAskRequest }, { readLlmConfig }, { createAskResponse }, { getBackend }] =
          await Promise.all([
            import('#/lib/ask/messages'),
            import('#/lib/ask/config'),
            import('#/lib/ask/answer'),
            import('#/lib/get-backend'),
          ])

        let parsed: ReturnType<typeof parseAskRequest>
        try {
          parsed = parseAskRequest(await request.json())
        } catch (err) {
          if (err instanceof AskRequestError) return errorResponse(err.status, err.message)
          return errorResponse(400, 'The request body is not valid JSON')
        }

        let llm: ReturnType<typeof readLlmConfig>
        try {
          llm = readLlmConfig()
        } catch (err) {
          return errorResponse(500, err instanceof Error ? err.message : 'The Ask configuration is invalid.')
        }
        if (!llm) {
          return errorResponse(
            503,
            'No language model is configured. Set OPENAI_API_KEY (or ASK_LLM_API_KEY) in the app server environment and restart.',
          )
        }

        const backend = await getBackend()
        return createAskResponse(backend, llm, parsed, request.signal)
      },
    },
  },
})
