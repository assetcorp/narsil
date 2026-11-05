export interface VectorSet {
  ids: readonly string[]
  dimension: number
  components: Float32Array
}

export interface ExactNeighbour {
  id: string
  similarity: number
}

export interface CosineScan {
  similaritiesTo(query: ArrayLike<number>): Float64Array
  nearest(query: ArrayLike<number>, k: number): ExactNeighbour[]
  rowOf(id: string): number
}

function magnitudesOf(set: VectorSet): Float64Array {
  const magnitudes = new Float64Array(set.ids.length)
  for (let row = 0; row < set.ids.length; row++) {
    let sum = 0
    const start = row * set.dimension
    for (let component = 0; component < set.dimension; component++) {
      const value = set.components[start + component]
      sum += value * value
    }
    magnitudes[row] = Math.sqrt(sum)
  }
  return magnitudes
}

export function cosineScan(set: VectorSet): CosineScan {
  if (set.components.length !== set.ids.length * set.dimension) {
    throw new Error(`the set holds ${set.components.length} components for ${set.ids.length} vectors`)
  }
  const magnitudes = magnitudesOf(set)
  const rows = new Map<string, number>()
  set.ids.forEach((id, row) => {
    if (rows.has(id)) throw new Error(`the set repeats the ID ${id}`)
    rows.set(id, row)
  })

  function similaritiesTo(query: ArrayLike<number>): Float64Array {
    if (query.length !== set.dimension) throw new Error(`a query holds ${query.length} components`)
    let sum = 0
    for (let component = 0; component < set.dimension; component++) sum += query[component] * query[component]
    const queryMagnitude = Math.sqrt(sum)
    const similarities = new Float64Array(set.ids.length)
    for (let row = 0; row < set.ids.length; row++) {
      const start = row * set.dimension
      let dot = 0
      for (let component = 0; component < set.dimension; component++) {
        dot += query[component] * set.components[start + component]
      }
      const denominator = queryMagnitude * magnitudes[row]
      similarities[row] = denominator === 0 ? 0 : dot / denominator
    }
    return similarities
  }

  return {
    similaritiesTo,
    nearest(query, k) {
      const similarities = similaritiesTo(query)
      const ranked = Array.from(set.ids.keys()).sort(
        (left, right) => similarities[right] - similarities[left] || left - right,
      )
      return ranked.slice(0, k).map(row => ({ id: set.ids[row], similarity: similarities[row] }))
    },
    rowOf(id) {
      const row = rows.get(id)
      if (row === undefined) throw new Error(`the set holds no vector for ${id}`)
      return row
    },
  }
}

export function recallAgainst(
  returned: readonly string[],
  exact: readonly ExactNeighbour[],
  k: number,
  similarityOf: (id: string) => number,
  tolerance: number,
): number {
  if (exact.length < k) throw new Error(`the exact list holds ${exact.length} neighbours, under ${k}`)
  const threshold = exact[k - 1].similarity - tolerance
  const seen = new Set<string>()
  let found = 0
  for (const id of returned.slice(0, k)) {
    if (seen.has(id)) continue
    seen.add(id)
    if (similarityOf(id) >= threshold) found += 1
  }
  return found / k
}
