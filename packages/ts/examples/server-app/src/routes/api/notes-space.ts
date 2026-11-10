import { createFileRoute } from '@tanstack/react-router'

async function open(request: Request): Promise<Response> {
  const { notesIdentity } = await import('#/lib/notes-identity')
  return notesIdentity(request, true)
}

export const Route = createFileRoute('/api/notes-space')({
  server: { handlers: { POST: ({ request }) => open(request) } },
})
