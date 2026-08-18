export interface SeededPrng {
  next(): number
  nextInt(min: number, max: number): number
  nextBool(probability: number): boolean
}

export function createSeededPrng(seed: number): SeededPrng {
  let state = seed | 0

  function next(): number {
    state = (state + 0x6d2b79f5) | 0
    let t = Math.imul(state ^ (state >>> 15), 1 | state)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 0x100000000
  }

  return {
    next,

    nextInt(min: number, max: number): number {
      if (min >= max) {
        return min
      }
      return min + Math.floor(next() * (max - min))
    },

    nextBool(probability: number): boolean {
      return next() < probability
    },
  }
}
