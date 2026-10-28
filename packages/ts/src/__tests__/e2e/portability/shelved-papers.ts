import type { HttpIndexConfig } from '../../../client'
import type { AnyDocument } from '../../../types/schema'

const DIMENSION = 24
const SHELVES = 50
const CENTRES = 16
const SPREAD = 0.6
const QUERY_COUNT = 20
const PROMOTION_THRESHOLD = 100

export const INDEX = 'shelves'

export const shelvesConfig: HttpIndexConfig = {
  schema: { shelf: 'number', embedding: `vector[${DIMENSION}]` },
  vectorPromotion: { threshold: PROMOTION_THRESHOLD, quantization: 'none' },
}

export type ShelvedPaper = AnyDocument & {
  id: string
  shelf: number
  embedding: number[]
}

export type Library = Map<string, ShelvedPaper>

const SEED = 20261028

function seededRandom(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    return state / 4294967296
  }
}

const random = seededRandom(SEED)
const centres = Array.from({ length: CENTRES }, () => Array.from({ length: DIMENSION }, () => random() * 2 - 1))

export function nearCentre(): number[] {
  const centre = centres[Math.floor(random() * CENTRES)]
  return centre.map(value => Math.fround(value + (random() - 0.5) * SPREAD))
}

export function randomShelf(): number {
  return Math.floor(random() * SHELVES)
}

export const queries = Array.from({ length: QUERY_COUNT }, nearCentre)

export function papersFrom(start: number, count: number): ShelvedPaper[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `paper-${String(start + i).padStart(5, '0')}`,
    shelf: randomShelf(),
    embedding: nearCentre(),
  }))
}
