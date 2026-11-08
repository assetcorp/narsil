import { placePinned } from '#platform/pinned-core'
import { ErrorCodes, NarsilError } from '../errors'

export function pinnedOrder(
  ids: readonly string[],
  pins: readonly { docId: string; position: number }[],
  depth: number | null,
): { order: Int32Array; ranked: Int32Array } {
  if (ids.length > 0x7fffffff || pins.length > 0x7fffffff) {
    throw new NarsilError(
      ErrorCodes.CONFIG_INVALID,
      'The ranked result and pin lists must each fit signed 32-bit positions',
    )
  }
  const byId = new Map<string, number>()
  for (let at = 0; at < ids.length; at++) byId.set(ids[at], at)
  const ranked = new Int32Array(pins.length)
  const positions = new Uint32Array(pins.length)
  let removed = 0
  let placed = 0
  let widePositions = false
  for (let pin = 0; pin < pins.length; pin++) {
    const entry = pins[pin]
    if (!Number.isInteger(entry.position) || entry.position < 0) {
      throw new NarsilError(ErrorCodes.CONFIG_INVALID, 'A pinned document position must be a non-negative integer', {
        docId: entry.docId,
        position: entry.position,
      })
    }
    ranked[pin] = byId.get(entry.docId) ?? -1
    positions[pin] = Math.min(entry.position, 0xffffffff)
    if (ranked[pin] >= 0) removed++
    if (depth === null || entry.position < depth) placed++
    if (entry.position > 0xffffffff) widePositions = true
  }
  const output = new Int32Array(ids.length - removed + placed)
  const source = widePositions
    ? Uint32Array.from(pins, (_, pin) => pin).sort(
        (left, right) => pins[left].position - pins[right].position || left - right,
      )
    : null
  const count = placePinned(
    ids.length,
    source === null ? ranked : Int32Array.from(source, pin => ranked[pin]),
    source === null ? positions : Uint32Array.from(source, pin => positions[pin]),
    depth,
    output,
  )
  if (count < 0) {
    throw new NarsilError(ErrorCodes.CONFIG_INVALID, 'The pinned documents cannot be placed', { status: count })
  }
  if (source !== null) {
    for (let at = 0; at < count; at++) if (output[at] < 0) output[at] = -1 - source[-1 - output[at]]
  }
  return { order: output.subarray(0, count), ranked }
}
