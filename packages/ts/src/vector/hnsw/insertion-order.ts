const GOLDEN_GAMMA = 0x9e3779b9
const FIRST_MIX_MULTIPLIER = 0x21f0aaad
const SECOND_MIX_MULTIPLIER = 0x735a2d97
const TWO_TO_THE_32 = 0x1_0000_0000
const HALF_A_STEP = 0.5

function mixedUint32(value: number): number {
  let mixed = (value + GOLDEN_GAMMA) | 0
  mixed ^= mixed >>> 16
  mixed = Math.imul(mixed, FIRST_MIX_MULTIPLIER)
  mixed ^= mixed >>> 15
  mixed = Math.imul(mixed, SECOND_MIX_MULTIPLIER)
  mixed ^= mixed >>> 15
  return mixed >>> 0
}

export function unitDrawOf(value: number): number {
  return (mixedUint32(value) + HALF_A_STEP) / TWO_TO_THE_32
}

export function shuffleInPlace<T>(items: T[]): T[] {
  let stream = items.length
  for (let i = items.length - 1; i > 0; i--) {
    stream = mixedUint32(stream)
    const j = Math.floor((stream / TWO_TO_THE_32) * (i + 1))
    const held = items[i]
    items[i] = items[j]
    items[j] = held
  }
  return items
}
