import type { BM25FieldParams, BM25Params } from '../types/schema'
import { DEFAULT_BM25_B, DEFAULT_BM25_K1, MAX_BM25_B, MAX_BM25_K1 } from './constants'

export function computeIDF(docFrequency: number, totalDocs: number): number {
  if (totalDocs === 0) return 0
  return Math.log((totalDocs - docFrequency + 0.5) / (docFrequency + 0.5) + 1)
}

function pairKeepsBoundSound(k1: number, b: number): boolean {
  return k1 >= 0 && k1 <= MAX_BM25_K1 && b >= 0 && b <= MAX_BM25_B
}

export function bm25PruningSound(params?: BM25Params): boolean {
  const k1 = params?.k1 ?? DEFAULT_BM25_K1
  const b = params?.b ?? DEFAULT_BM25_B
  if (!pairKeepsBoundSound(k1, b)) return false
  const fields = params?.fields
  if (fields === undefined) return true
  for (const name of Object.keys(fields)) {
    if (!pairKeepsBoundSound(fields[name].k1 ?? k1, fields[name].b ?? b)) return false
  }
  return true
}

export function bm25SetsValue(params: BM25Params | undefined): boolean {
  if (typeof params !== 'object' || params === null) return params !== undefined
  if (params.k1 !== undefined || params.b !== undefined) return true
  const fields = params.fields
  if (fields === undefined) return false
  if (typeof fields !== 'object' || fields === null) return true
  for (const name of Object.keys(fields)) {
    const pair = fields[name]
    if (typeof pair !== 'object' || pair === null) return true
    if (pair.k1 !== undefined || pair.b !== undefined) return true
  }
  return false
}

function ownField(fields: BM25Params['fields'], name: string): BM25FieldParams | undefined {
  return fields !== undefined && Object.hasOwn(fields, name) ? fields[name] : undefined
}

export function mergeBM25Levels(search: BM25Params | undefined, index: BM25Params | undefined): BM25Params | undefined {
  if (search === undefined || !bm25SetsValue(search)) return index
  const k1 = search.k1 ?? index?.k1
  const b = search.b ?? index?.b
  const merged: BM25Params = {
    ...(k1 !== undefined ? { k1 } : {}),
    ...(b !== undefined ? { b } : {}),
  }
  const names = [...Object.keys(search.fields ?? {}), ...Object.keys(index?.fields ?? {})]
  if (names.length === 0) return merged
  const fields: Record<string, BM25FieldParams> = Object.create(null)
  for (const name of names) {
    const fromSearch = ownField(search.fields, name)
    const fromIndex = ownField(index?.fields, name)
    const fieldK1 = fromSearch?.k1 ?? search.k1 ?? fromIndex?.k1
    const fieldB = fromSearch?.b ?? search.b ?? fromIndex?.b
    fields[name] = {
      ...(fieldK1 !== undefined ? { k1: fieldK1 } : {}),
      ...(fieldB !== undefined ? { b: fieldB } : {}),
    }
  }
  merged.fields = fields
  return merged
}

export function computeBM25WithIDF(
  termFrequency: number,
  idf: number,
  fieldLength: number,
  avgFieldLength: number,
  k1: number,
  b: number,
): number {
  if (avgFieldLength === 0) return 0

  const numerator = termFrequency * (k1 + 1)
  const denominator = termFrequency + k1 * (1 - b + (b * fieldLength) / avgFieldLength)

  if (denominator === 0) return 0
  return idf * (numerator / denominator)
}
