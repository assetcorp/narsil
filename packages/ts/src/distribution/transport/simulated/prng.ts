export interface SeededPrng {
  next(): number
  nextInt(min: number, max: number): number
  nextBool(probability: number): boolean
}

const FNV_OFFSET_BASIS = 0x811c9dc5
const FNV_PRIME = 0x01000193

export function deriveStreamSeed(seed: number, streamName: string): number {
  let hash = (seed ^ FNV_OFFSET_BASIS) | 0
  for (let i = 0; i < streamName.length; i++) {
    hash = Math.imul(hash ^ streamName.charCodeAt(i), FNV_PRIME)
  }
  return hash | 0
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
