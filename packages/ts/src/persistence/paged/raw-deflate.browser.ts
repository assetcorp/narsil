import { ErrorCodes, NarsilError } from '../../errors'

function diskIndexesUnavailable(): never {
  throw new NarsilError(ErrorCodes.CONFIG_INVALID, 'A disk index requires a Node.js runtime')
}

export function deflateBlock(_raw: Uint8Array): Uint8Array {
  return diskIndexesUnavailable()
}

export function inflateBlock(_compressed: Uint8Array, _rawLength: number): Uint8Array {
  return diskIndexesUnavailable()
}
