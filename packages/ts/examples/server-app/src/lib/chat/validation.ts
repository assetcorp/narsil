export const THREAD_ID_PATTERN = /^[a-zA-Z0-9._-]{1,64}$/

export function parseThreadIdInput(input: unknown): { id: string } {
  if (typeof input !== 'object' || input === null) {
    throw new Error('The request must be an object with a thread "id"')
  }
  const { id } = input as Record<string, unknown>
  if (typeof id !== 'string' || !THREAD_ID_PATTERN.test(id)) {
    throw new Error('Field "id" must identify a conversation')
  }
  return { id }
}
