import type { IndexConfig } from '../../types/schema'
import type { QueryParams } from '../../types/search'

export const fusionIndex: IndexConfig = {
  schema: { positive: 'string', negative: 'string', neutral: 'string', kind: 'enum', embedding: 'vector[2]' },
  language: 'english',
}

export const fusionDocuments = [
  { id: 'positive', positive: 'lamp light', negative: '', neutral: '', kind: 'positive', embedding: [1, 0] },
  { id: 'negative', positive: '', negative: 'lamp light', neutral: '', kind: 'negative', embedding: [1, 0] },
  {
    id: 'cancelled',
    positive: 'lamp light',
    negative: 'lamp light',
    neutral: '',
    kind: 'cancelled',
    embedding: [1, 0],
  },
  { id: 'zero', positive: '', negative: '', neutral: 'lamp light', kind: 'zero', embedding: [1, 0] },
  ...Array.from({ length: 56 }, (_, index) => ({
    id: `desk-${index}`,
    positive: 'desk',
    negative: 'desk',
    neutral: 'desk',
    kind: 'desk',
  })),
]

export function fusionQuery(scale: number, alpha: number): QueryParams {
  return {
    term: 'lamp light',
    termMatch: 'any',
    boost: { positive: scale, negative: -scale, neutral: 0 },
    bm25: { k1: 0, b: 0 },
    scoring: 'dfs',
    vector: { field: 'embedding', value: [1, 0] },
    hybrid: { strategy: 'linear', alpha },
    limit: 60,
  }
}

export function expectedFusion(alpha: number, overflows: boolean): Array<{ id: string; score: number }> {
  const normalised = [
    { id: 'positive', score: 1 },
    { id: 'negative', score: 0 },
    { id: 'cancelled', score: overflows ? 0 : 0.5 },
    { id: 'zero', score: 0.5 },
  ]
  return normalised
    .map(({ id, score }) => ({ id, score: alpha + (1 - alpha) * score }))
    .sort((left, right) => right.score - left.score || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0))
}
