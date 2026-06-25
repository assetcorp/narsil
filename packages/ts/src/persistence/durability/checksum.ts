import { crc32 } from '../../serialization/crc32'

export { crc32 }

export function checksumMatches(data: Uint8Array, expected: number): boolean {
  return crc32(data) === expected
}
