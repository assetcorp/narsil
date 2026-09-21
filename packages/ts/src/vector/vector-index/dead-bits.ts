export const NO_LIVE_VECTOR_AT_POSITION = -1

export function deadBytesFor(count: number): number {
  return Math.ceil(count / 8)
}

export function isDead(dead: Uint8Array | null, position: number): boolean {
  return dead !== null && ((dead[position >> 3] >> (position & 7)) & 1) === 1
}

export function countDead(dead: Uint8Array | null, count: number): number {
  if (dead === null) return 0
  let found = 0
  for (let position = 0; position < count; position++) {
    if (isDead(dead, position)) found += 1
  }
  return found
}

export function deadBitsWhere(count: number, isDeadAt: (position: number) => boolean): Uint8Array | null {
  let dead: Uint8Array | null = null
  for (let position = 0; position < count; position++) {
    if (!isDeadAt(position)) continue
    dead ??= new Uint8Array(deadBytesFor(count))
    dead[position >> 3] |= 1 << (position & 7)
  }
  return dead
}
