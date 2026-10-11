export interface LongitudeEdgeTree {
  readonly from: Int32Array
  readonly to: Int32Array
  readonly low: Float64Array
  readonly high: Float64Array
  readonly subtreeHigh: Float64Array
}

export function buildLongitudeEdgeTree(lons: Float64Array): LongitudeEdgeTree {
  const n = lons.length
  const edges: number[] = []
  for (let i = 0; i < n; i++) {
    if (lons[i] !== lons[i === 0 ? n - 1 : i - 1]) edges.push(i)
  }
  const lowOf = (i: number): number => Math.min(lons[i], lons[i === 0 ? n - 1 : i - 1])
  edges.sort((left, right) => lowOf(left) - lowOf(right))

  const count = edges.length
  const tree: LongitudeEdgeTree = {
    from: new Int32Array(count),
    to: new Int32Array(count),
    low: new Float64Array(count),
    high: new Float64Array(count),
    subtreeHigh: new Float64Array(count),
  }
  edges.forEach((i, at) => {
    const j = i === 0 ? n - 1 : i - 1
    tree.from[at] = i
    tree.to[at] = j
    tree.low[at] = Math.min(lons[i], lons[j])
    tree.high[at] = Math.max(lons[i], lons[j])
  })
  const fillSubtreeHigh = (start: number, end: number): number => {
    if (start >= end) return Number.NEGATIVE_INFINITY
    const mid = (start + end) >>> 1
    const highest = Math.max(tree.high[mid], fillSubtreeHigh(start, mid), fillSubtreeHigh(mid + 1, end))
    tree.subtreeHigh[mid] = highest
    return highest
  }
  fillSubtreeHigh(0, count)
  return tree
}

export function forEachEdgeSpanning(
  tree: LongitudeEdgeTree,
  lon: number,
  visit: (from: number, to: number) => void,
): void {
  const walk = (start: number, end: number): void => {
    if (start >= end) return
    const mid = (start + end) >>> 1
    if (tree.subtreeHigh[mid] <= lon) return
    walk(start, mid)
    if (tree.low[mid] > lon) return
    if (lon < tree.high[mid]) visit(tree.from[mid], tree.to[mid])
    walk(mid + 1, end)
  }
  walk(0, tree.from.length)
}
