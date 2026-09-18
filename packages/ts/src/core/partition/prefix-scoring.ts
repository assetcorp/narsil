import type { PostingListView } from '../../types/internal'
import { bitsetHas } from '../bitset'
import type { InvertedIndexReader } from '../inverted-index'
import { computeBM25WithIDF, computeIDF } from '../scorer'
import { type FieldScoring, fieldLengthOf } from './field-scoring'
import { postingColumns } from './posting-columns'
import { EMPTY_COMPONENTS, type PrefixContribution, type PrefixMatch } from './scoring'

export interface PrefixScoringContext {
  index: Pick<InvertedIndexReader, 'lookup'>
  fields: FieldScoring
  fieldNames: readonly string[]
  totalDocs: number
  k1: number
  b: number
  filterBitset: Uint32Array | undefined
  documentFrequency(token: string, list: PostingListView): number
}

export function resolvePrefixMatches(
  context: PrefixScoringContext,
  token: string,
  expansionTerms: readonly string[],
): PrefixMatch[] {
  const found: Array<{ token: string; postingList: PostingListView; docFreq: number }> = []
  const seen = new Set<string>()
  for (const term of [token, ...expansionTerms]) {
    if (seen.has(term)) continue
    seen.add(term)
    const postingList = context.index.lookup(term)
    if (!postingList) continue
    found.push({ token: term, postingList, docFreq: context.documentFrequency(term, postingList) })
  }
  if (found.length === 0) return []

  let blendedDf = 0
  for (const f of found) {
    if (f.docFreq > blendedDf) blendedDf = f.docFreq
  }
  const blendedIdf = computeIDF(blendedDf, context.totalDocs)

  return found.map(f => ({
    token: f.token,
    factor: Math.min(1, token.length / f.token.length),
    postingList: f.postingList,
    docFreq: blendedDf,
    idf: blendedIdf,
  }))
}

export function computePrefixContributions(
  context: PrefixScoringContext,
  matches: readonly PrefixMatch[],
  collect: boolean,
): Map<number, PrefixContribution> {
  const { fields, fieldNames, filterBitset, k1, b } = context
  const scoresAreZero = context.totalDocs === 0
  const best = new Map<number, PrefixContribution>()

  for (const match of matches) {
    const perTerm = new Map<number, PrefixContribution>()
    const { docIds, termFrequencies, fieldNameIndices, deletedDocs, hasDeleted, count } = postingColumns(
      match.postingList,
    )

    for (let pi = 0; pi < count; pi++) {
      const internalId = docIds[pi]
      if (hasDeleted && deletedDocs.has(internalId)) continue
      if (filterBitset && !bitsetHas(filterBitset, internalId)) continue
      const fieldIndex = fieldNameIndices[pi]
      if (fields.searchable[fieldIndex] === 0) continue
      const fieldName = fieldNames[fieldIndex]

      const termFrequency = termFrequencies[pi]
      const fieldBoost = fields.boosts[fieldIndex]
      const avgLen = fields.averageLengths[fieldIndex]
      const actualFieldLength = fieldLengthOf(fields.lengthColumns, fieldIndex, internalId, avgLen)

      const termScore =
        (scoresAreZero ? 0 : computeBM25WithIDF(termFrequency, match.idf, actualFieldLength, avgLen, k1, b)) *
        fieldBoost *
        match.factor

      const existing = perTerm.get(internalId)
      if (existing) {
        existing.score += termScore
        if (collect) {
          existing.termFrequencies[`${fieldName}:${match.token}`] = termFrequency
          existing.fieldLengths[fieldName] = actualFieldLength
        }
      } else if (collect) {
        perTerm.set(internalId, {
          score: termScore,
          token: match.token,
          idf: match.idf,
          termFrequencies: { [`${fieldName}:${match.token}`]: termFrequency },
          fieldLengths: { [fieldName]: actualFieldLength },
        })
      } else {
        perTerm.set(internalId, {
          score: termScore,
          token: match.token,
          idf: match.idf,
          termFrequencies: EMPTY_COMPONENTS,
          fieldLengths: EMPTY_COMPONENTS,
        })
      }
    }

    for (const [internalId, contribution] of perTerm) {
      const current = best.get(internalId)
      if (!current || contribution.score > current.score) {
        best.set(internalId, contribution)
      }
    }
  }

  return best
}
