const FLOAT32_BYTES = 4

function float32Of(bytes: Uint8Array): Float32Array {
  return new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength))
}

export function restoreVectorValues(value: unknown): unknown {
  if (value instanceof Uint8Array) {
    return value.byteLength % FLOAT32_BYTES === 0 ? float32Of(value) : value
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) value[i] = restoreVectorValues(value[i])
    return value
  }
  if (typeof value === 'object' && value !== null && !ArrayBuffer.isView(value)) {
    const record = value as Record<string, unknown>
    for (const key of Object.keys(record)) record[key] = restoreVectorValues(record[key])
  }
  return value
}
