import { createFileRoute } from '@tanstack/react-router'

function jsonError(status: number, message: string): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

export const Route = createFileRoute('/api/ask')({
  server: {
    handlers: {
      POST: async ({ request }) => {
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
          if (err instanceof AskRequestError) return jsonError(err.status, err.message)
          return jsonError(400, 'The request body is not valid JSON')
        }

        const llm = readLlmConfig()
        if (!llm) {
          return jsonError(
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
