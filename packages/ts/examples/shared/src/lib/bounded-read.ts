export const MAX_SYNC_INDEX_NAME_LENGTH = 256

export async function readStreamBytes(
  stream: ReadableStream<Uint8Array> | null,
  maxBytes = Number.POSITIVE_INFINITY,
): Promise<Uint8Array<ArrayBuffer> | null> {
  if (stream === null) return new Uint8Array(0)
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  let totalBytes = 0
  for (;;) {
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
  return joined
}

export async function readBoundedText(
  body: { headers: Headers; body: ReadableStream<Uint8Array> | null },
  maxBytes: number,
): Promise<string | null> {
  const declared = Number(body.headers.get('content-length') ?? 0)
  if (declared > maxBytes) return null
  const bytes = await readStreamBytes(body.body, maxBytes)
  return bytes === null ? null : new TextDecoder().decode(bytes)
}
