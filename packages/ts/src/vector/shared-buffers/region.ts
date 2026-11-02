import { reserveVectorRegion } from '#platform/vector-memory-limits'
import { ErrorCodes, NarsilError } from '../../errors'

function reserve(maxBytes: number): ArrayBuffer | null {
  try {
    return reserveVectorRegion(maxBytes)
  } catch (err) {
    if (err instanceof NarsilError) throw err
    throw new NarsilError(
      ErrorCodes.PARTITION_CAPACITY_EXCEEDED,
      `The device could not reserve ${maxBytes} bytes of address space for a vector structure. Remove vector fields or indexes that the app no longer needs.`,
      { bytes: maxBytes, cause: err instanceof Error ? err.message : String(err) },
    )
  }
}

export function createRegionBuffer(initialBytes: number, maxBytes: number): ArrayBuffer | null {
  const reserved = reserve(maxBytes)
  if (reserved === null) return null
  const reservedBytes = reserved.byteLength
  let logicalBytes = Math.min(initialBytes, reservedBytes)
  Object.defineProperties(reserved, {
    byteLength: { get: () => logicalBytes },
    maxByteLength: { value: reservedBytes },
    resizable: { value: true },
    resize: {
      value(target: number): void {
        if (!Number.isInteger(target) || target < 0 || target > reservedBytes) {
          throw new RangeError(`A vector region can hold between 0 and ${reservedBytes} bytes, not ${target}`)
        }
        if (target < logicalBytes) new Uint8Array(reserved, target, logicalBytes - target).fill(0)
        logicalBytes = target
      },
    },
  })
  return reserved
}
