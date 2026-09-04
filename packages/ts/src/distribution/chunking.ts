/**
 * The ceiling one wire batch fills before the next one starts.
 *
 * @internal
 */
export interface ChunkBudget<T> {
  /** No chunk holds more than this many items. */
  maxCount: number
  /** No chunk's estimated encoding passes this many bytes, unless one item alone does. */
  maxBytes: number
  /** Each item is charged this much on top of its payload, for the fields around it. */
  overheadBytes: number
  /** How many payload bytes an item carries. */
  payloadBytesOf(item: T): number
  /** Answers true where `item` cannot share a chunk with the item before it, which keeps a run contiguous. */
  breaksRun?(item: T, previous: T): boolean
}

/**
 * Splits a list into the batches one transport carries, so a large write never
 * builds a message the peer refuses. A chunk closes on the item count, on the
 * estimated byte count, or where the budget says the run breaks, and an item
 * larger than the byte ceiling travels alone rather than being dropped.
 *
 * @param items - The list to split, in the order it must stay in.
 * @param budget - The ceilings and the item measurements.
 * @returns The chunks, each holding at least one item, covering every item once.
 *
 * @internal
 */
export function chunkByBudget<T>(items: T[], budget: ChunkBudget<T>): T[][] {
  const chunks: T[][] = []
  let current: T[] = []
  let currentBytes = 0

  for (const item of items) {
    const itemBytes = budget.payloadBytesOf(item) + budget.overheadBytes
    const previous = current[current.length - 1]
    const breaksRun = previous !== undefined && budget.breaksRun?.(item, previous) === true
    const overflows =
      current.length >= budget.maxCount || (current.length > 0 && currentBytes + itemBytes > budget.maxBytes)

    if (breaksRun || overflows) {
      chunks.push(current)
      current = []
      currentBytes = 0
    }

    current.push(item)
    currentBytes += itemBytes
  }

  if (current.length > 0) {
    chunks.push(current)
  }

  return chunks
}
