function toPlainNumbers(key: string, value: unknown): unknown {
  if (ArrayBuffer.isView(value) && !(value instanceof DataView)) {
    return Array.from(value as unknown as ArrayLike<number>)
  }
  void key
  return value
}

/**
 * Encodes a request body as JSON, writing a typed array as the array of
 * numbers it holds.
 *
 * The engine takes a vector as a number array or a `Float32Array`, in a
 * document field and in {@link VectorQueryConfig.value} alike, and it stores
 * one as a `Float32Array`. `JSON` writes a `Float32Array` as an object keyed by
 * index, which no route reads back as a vector, so both the client's requests
 * and the server's answers go through here.
 *
 * @param value - This is the request or the answer to encode.
 * @returns The JSON text goes on the wire.
 */
export function encodeJson(value: unknown): string {
  return JSON.stringify(value, toPlainNumbers)
}
