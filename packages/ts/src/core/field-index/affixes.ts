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

interface Column {
  keys: string[]
  values: string[]
}

function settledColumn(column: Column, holds: (value: string) => boolean): Column {
  const { keys, values } = column
  const order: number[] = []
  for (let at = 0; at < keys.length; at++) if (holds(values[at])) order.push(at)
  order.sort((left, right) => compareUnits(keys[left], keys[right]) || compareUnits(values[left], values[right]))
  const settled: Column = { keys: [], values: [] }
  for (const at of order) {
    const last = settled.values.length - 1
    if (last >= 0 && settled.keys[last] === keys[at] && settled.values[last] === values[at]) continue
    settled.keys.push(keys[at])
    settled.values.push(values[at])
  }
  return settled
}

export class ValueAffixes {
  private forward: Column = { keys: [], values: [] }
  private backward: Column = { keys: [], values: [] }
  private settled = true

  constructor(
    private readonly holds: (value: string) => boolean,
    values: Iterable<string>,
  ) {
    for (const value of values) this.add(value)
  }

  add(value: string): void {
    this.forward.keys.push(value)
    this.forward.values.push(value)
    this.backward.keys.push(reversedUnits(value))
    this.backward.values.push(value)
    this.settled = false
  }

  forget(): void {
    this.settled = false
  }

  withPrefix(prefix: string): string[] {
    this.settle()
    return this.matching(this.forward, prefix)
  }

  withSuffix(suffix: string): string[] {
    this.settle()
    return this.matching(this.backward, reversedUnits(suffix))
  }

  private settle(): void {
    if (this.settled) return
    this.forward = settledColumn(this.forward, this.holds)
    this.backward = settledColumn(this.backward, this.holds)
    this.settled = true
  }

  private matching(column: Column, start: string): string[] {
    const found: string[] = []
    for (let at = firstAtOrAfter(column.keys, start); at < column.keys.length; at++) {
      if (!column.keys[at].startsWith(start)) break
      found.push(column.values[at])
    }
    return found
  }
}
