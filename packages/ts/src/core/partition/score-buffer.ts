import type { ScoredDocument } from '../../types/internal'
import type { ScoreComponents } from './scoring'
import { EMPTY_COMPONENTS } from './scoring'
import { buildMinHeap, candidateWorse, siftDown, sortSelection, type TopKCandidate } from './top-k-heap'

const INITIAL_TOUCHED_CAPACITY = 1024
const MAX_GENERATION = 0x7fffffff

/**
 * The running scores of one scored query, held as a flat array indexed by
 * internal document id. A generation stamp marks the slots this query has
 * written, so a query never clears the array and never allocates a record per
 * matching document.
 *
 * @internal
 */
export interface ScoreBuffer {
  scores: Float64Array
  stamps: Int32Array
  touched: Int32Array
  touchedCount: number
  generation: number
}

/**
 * Creates a scoring buffer sized to hold one slot per internal document id.
 *
 * @param capacity - The partition's internal id capacity.
 * @returns The buffer, ready for its first query.
 */
export function createScoreBuffer(capacity: number): ScoreBuffer {
  return {
    scores: new Float64Array(capacity),
    stamps: new Int32Array(capacity),
    touched: new Int32Array(Math.max(1, Math.min(capacity, INITIAL_TOUCHED_CAPACITY))),
    touchedCount: 0,
    generation: 0,
  }
}

/**
 * Opens a fresh scoring pass on the buffer, growing it where the partition has
 * taken on more documents and rolling the generation stamp forward so every
 * slot from the previous pass reads as empty.
 *
 * @param buffer - The buffer to reset.
 * @param capacity - The partition's current internal id capacity.
 */
export function beginScoring(buffer: ScoreBuffer, capacity: number): void {
  if (buffer.scores.length < capacity) {
    buffer.scores = new Float64Array(capacity)
    buffer.stamps = new Int32Array(capacity)
    buffer.generation = 0
  }
  if (buffer.generation >= MAX_GENERATION) {
    buffer.stamps.fill(0)
    buffer.generation = 0
  }
  buffer.generation++
  buffer.touchedCount = 0
}

function appendTouched(buffer: ScoreBuffer, internalId: number): void {
  if (buffer.touchedCount === buffer.touched.length) {
    const grown = new Int32Array(buffer.touched.length * 2)
    grown.set(buffer.touched)
    buffer.touched = grown
  }
  buffer.touched[buffer.touchedCount] = internalId
  buffer.touchedCount++
}

/**
 * Adds one term's contribution to a document's running score, recording the
 * document as matched the first time it is seen.
 *
 * @param buffer - The buffer holding this query's scores.
 * @param internalId - The internal id of the document that matched.
 * @param termScore - The contribution to add.
 */
export function addScore(buffer: ScoreBuffer, internalId: number, termScore: number): void {
  if (buffer.stamps[internalId] === buffer.generation) {
    buffer.scores[internalId] += termScore
    return
  }
  buffer.stamps[internalId] = buffer.generation
  buffer.scores[internalId] = termScore
  appendTouched(buffer, internalId)
}

/**
 * Reports whether this query has already scored the given document, which is
 * what an intersecting query reads to drop a document that missed an earlier
 * term.
 *
 * @param buffer - The buffer holding this query's scores.
 * @param internalId - The internal id to test.
 * @returns True where the document already carries a score in this pass.
 */
export function hasScore(buffer: ScoreBuffer, internalId: number): boolean {
  return buffer.stamps[internalId] === buffer.generation
}

/**
 * Takes the highest-scoring documents out of the buffer, resolving an external
 * id only for a document that can still reach the page. Ties break on the
 * document id, and a document whose id no longer resolves is left out.
 *
 * @param buffer - The buffer holding this query's scores.
 * @param k - How many documents to return.
 * @param resolver - Maps an internal id to the document's external id.
 * @param components - The per-document scoring records, where the query asked for them.
 * @returns The documents in descending score order.
 */
export function topKFromBuffer(
  buffer: ScoreBuffer,
  k: number,
  resolver: { toExternal(id: number): string | undefined },
  components: Map<number, ScoreComponents> | null,
): ScoredDocument[] {
  const wanted = Number.isFinite(k) ? Math.max(0, Math.floor(k)) : 0
  if (wanted <= 0) return []

  const heap: TopKCandidate[] = []
  const { touched, touchedCount, scores } = buffer
  let full = false
  let threshold = 0

  for (let index = 0; index < touchedCount; index++) {
    const internalId = touched[index]
    const score = scores[internalId]
    if (full && score < threshold) continue

    const externalId = resolver.toExternal(internalId)
    if (externalId === undefined) continue
    const candidate: TopKCandidate = { internalId, externalId, score }

    if (!full) {
      heap.push(candidate)
      if (heap.length === wanted) {
        buildMinHeap(heap)
        full = true
        threshold = heap[0].score
      }
      continue
    }
    if (candidateWorse(heap[0], candidate)) {
      heap[0] = candidate
      siftDown(heap, 0)
      threshold = heap[0].score
    }
  }

  sortSelection(heap)

  const result: ScoredDocument[] = new Array(heap.length)
  for (let index = 0; index < heap.length; index++) {
    const entry = heap[index]
    const record = components?.get(entry.internalId)
    result[index] = {
      docId: entry.externalId,
      score: entry.score,
      termFrequencies: record?.termFrequencies ?? EMPTY_COMPONENTS,
      fieldLengths: record?.fieldLengths ?? EMPTY_COMPONENTS,
      idf: record?.idf ?? EMPTY_COMPONENTS,
    }
  }
  return result
}
