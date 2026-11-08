import { createFileRoute } from '@tanstack/react-router'

async function grant(request: Request): Promise<Response> {
  const { notesIdentity } = await import('#/lib/notes-identity')
  return notesIdentity(request, false)
}

export const Route = createFileRoute('/api/sync-grant')({
  server: {
    handlers: {
      POST: ({ request }) => grant(request),
    },
  },
})
