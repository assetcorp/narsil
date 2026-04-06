export function createBitSet(capacity: number): Uint32Array {
  return new Uint32Array((capacity + 31) >>> 5 || 1)
}

export function bitsetSet(bs: Uint32Array, index: number): void {
  bs[index >>> 5] |= 1 << (index & 31)
}

export function bitsetClear(bs: Uint32Array, index: number): void {
  bs[index >>> 5] &= ~(1 << (index & 31))
}

export function bitsetHas(bs: Uint32Array, index: number): boolean {
  return (bs[index >>> 5] & (1 << (index & 31))) !== 0
}

export function bitsetAnd(a: Uint32Array, b: Uint32Array): Uint32Array {
  const len = Math.min(a.length, b.length)
  const result = new Uint32Array(len)
  for (let i = 0; i < len; i++) {
    result[i] = a[i] & b[i]
  }
  return result
}

export function bitsetOr(a: Uint32Array, b: Uint32Array): Uint32Array {
  const longer = a.length >= b.length ? a : b
  const shorter = a.length >= b.length ? b : a
  const result = new Uint32Array(longer.length)
  for (let i = 0; i < shorter.length; i++) {
    result[i] = longer[i] | shorter[i]
  }
  for (let i = shorter.length; i < longer.length; i++) {
    result[i] = longer[i]
  }
  return result
}

export function bitsetNot(bs: Uint32Array, capacity: number): Uint32Array {
  const result = new Uint32Array(bs.length)
  const fullWords = capacity >>> 5
  for (let i = 0; i < fullWords; i++) {
    result[i] = ~bs[i]
  }
  const remainder = capacity & 31
  if (remainder > 0 && fullWords < bs.length) {
    result[fullWords] = ~bs[fullWords] & ((1 << remainder) - 1)
  }
  return result
}

export function bitsetCount(bs: Uint32Array): number {
  let count = 0
  for (let i = 0; i < bs.length; i++) {
    let word = bs[i]
    word = word - ((word >>> 1) & 0x55555555)
    word = (word & 0x33333333) + ((word >>> 2) & 0x33333333)
    count += (((word + (word >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24
  }
  return count
}

export function* bitsetIterator(bs: Uint32Array): Generator<number> {
  for (let i = 0; i < bs.length; i++) {
    let word = bs[i]
    if (word === 0) continue
    const base = i << 5
    while (word !== 0) {
      const tz = Math.clz32(word & -word) ^ 31
      yield base + tz
      word &= word - 1
    }
  }
}

export function bitsetFromSet(set: Set<number>, capacity: number): Uint32Array {
  const bs = createBitSet(capacity)
  for (const id of set) {
    bs[id >>> 5] |= 1 << (id & 31)
  }
  return bs
}

export function bitsetToSet(bs: Uint32Array): Set<number> {
  const result = new Set<number>()
  for (let i = 0; i < bs.length; i++) {
    let word = bs[i]
    if (word === 0) continue
    const base = i << 5
    while (word !== 0) {
      const tz = Math.clz32(word & -word) ^ 31
      result.add(base + tz)
      word &= word - 1
    }
  }
  return result
}
