function streamOf(data: Uint8Array) {
  return new Blob([data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer]).stream()
}

export async function gzip(data: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await new Response(streamOf(data).pipeThrough(new CompressionStream('gzip'))).arrayBuffer())
}

export async function gunzip(compressed: Uint8Array, maxBytes = Number.POSITIVE_INFINITY): Promise<Uint8Array> {
  const reader = streamOf(compressed).pipeThrough(new DecompressionStream('gzip')).getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > maxBytes) {
      await reader.cancel()
      throw Object.assign(new RangeError(`The compressed data inflates past ${maxBytes} bytes`), { code: 'EFBIG' })
    }
    chunks.push(value)
  }
  const result = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    result.set(chunk, offset)
    offset += chunk.byteLength
  }
  return result
}
