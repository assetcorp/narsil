import { deflateRawSync, inflateRawSync } from 'node:zlib'

export function deflateBlock(raw: Uint8Array): Uint8Array {
  return deflateRawSync(raw)
}

export function inflateBlock(compressed: Uint8Array, rawLength: number): Uint8Array {
  return inflateRawSync(compressed, { maxOutputLength: rawLength })
}
