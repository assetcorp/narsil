function compareUnits(left: string, right: string): number {
  if (left < right) return -1
  return left > right ? 1 : 0
}

function reversedUnits(value: string): string {
  let reversed = ''
  for (let at = value.length - 1; at >= 0; at--) reversed += value[at]
  return reversed
}

function firstAtOrAfter(sorted: readonly string[], key: string): number {
  let lo = 0
  let hi = sorted.length
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    if (sorted[mid] < key) lo = mid + 1
    else hi = mid
  }
  return lo
}

export class ValueAffixes {
  private readonly forward: string[]
  private readonly backward: string[]
  private readonly originalOfBackward: string[]

  constructor(values: Iterable<string>) {
    this.forward = [...values].sort(compareUnits)
    const pairs = this.forward.map(value => [reversedUnits(value), value] as const)
    pairs.sort((left, right) => compareUnits(left[0], right[0]))
    this.backward = pairs.map(pair => pair[0])
    this.originalOfBackward = pairs.map(pair => pair[1])
  }

  withPrefix(prefix: string): string[] {
    const found: string[] = []
    for (let at = firstAtOrAfter(this.forward, prefix); at < this.forward.length; at++) {
      if (!this.forward[at].startsWith(prefix)) break
      found.push(this.forward[at])
    }
    return found
  }

  withSuffix(suffix: string): string[] {
    const key = reversedUnits(suffix)
    const found: string[] = []
    for (let at = firstAtOrAfter(this.backward, key); at < this.backward.length; at++) {
      if (!this.backward[at].startsWith(key)) break
      found.push(this.originalOfBackward[at])
    }
    return found
  }
}
