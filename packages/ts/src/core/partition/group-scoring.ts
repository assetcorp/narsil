import type { ExpandedTermGroup, PostingListView } from '../../types/internal'
import { bitsetHas } from '../bitset'
import type { InvertedIndexReader } from '../inverted-index'
import { computeBM25WithIDF, computeIDF } from '../scorer'
import { type FieldScoring, fieldLengthOf } from './field-scoring'
import { postingColumns } from './posting-columns'
import type { PartitionReadState } from './read-state'
import { EMPTY_COMPONENTS, type GroupContribution, type GroupMatch } from './scoring'

export interface GroupScoringContext {
  index: Pick<InvertedIndexReader, 'lookup' | 'documentFrequency'>
  fields: FieldScoring
  partialMarks: Uint8Array
  fieldNames: readonly string[]
  totalDocs: number
  k1: number
  b: number
  filterBitset: Uint32Array | undefined
  globalFrequency(token: string): number | undefined
}

export function partialFieldMarks(
  fieldNames: readonly string[],
  partialFields: readonly string[] | undefined,
): Uint8Array {
  const marks = new Uint8Array(fieldNames.length)
  if (partialFields === undefined || partialFields.length === 0) return marks
  for (let fieldIndex = 0; fieldIndex < fieldNames.length; fieldIndex++) {
    if (partialFields.includes(fieldNames[fieldIndex])) marks[fieldIndex] = 1
  }
  return marks
}

export function termGroupOf(
  groups: readonly ExpandedTermGroup[] | undefined,
  token: string,
): ExpandedTermGroup | undefined {
  if (groups === undefined) return undefined
  for (const group of groups) {
    if (group.token === token) return group
  }
  return undefined
}

export function typoTokensOf(
  states: readonly PartitionReadState[],
  token: string,
  tolerance: number,
  prefixLength: number,
): string[] {
  const found = new Set<string>()
  for (const state of states) {
    for (const match of state.invertedIdx.fuzzyLookup(token, tolerance, prefixLength)) found.add(match.token)
  }
  return [...found]
}

export function typoMatchesFor(
  index: Pick<InvertedIndexReader, 'lookup' | 'fuzzyLookup'>,
  token: string,
  group: ExpandedTermGroup | undefined,
  exact: boolean,
  tolerance: number,
  prefixLength: number,
): Array<{ token: string; postingList: PostingListView }> {
  if (group !== undefined) {
    if (!group.typoMatches || exact || tolerance === 0) return []
    return index
      .fuzzyLookup(token, tolerance, prefixLength)
      .filter(match => match.token !== token && group.synonyms?.has(match.token) !== true)
  }
  if (!exact) return index.fuzzyLookup(token, tolerance, prefixLength)
  const postingList = index.lookup(token)
  return postingList ? [{ token, postingList }] : []
}

export function resolveGroupMatches(context: GroupScoringContext, group: ExpandedTermGroup): GroupMatch[] {
  const frequencyOf = (token: string): number =>
    context.globalFrequency(token) ?? context.index.documentFrequency(token)
  const lookup = (token: string): PostingListView | undefined => context.index.lookup(token)
  const synonyms = group.synonyms
  let groupDocumentFrequency = synonyms?.documentFrequency(frequencyOf) ?? 0
  const found: Array<{ token: string; factor: number; partialFactor: number; postingList: PostingListView }> = []
  for (const member of group.members) {
    const documents = frequencyOf(member.token)
    if (documents > groupDocumentFrequency) groupDocumentFrequency = documents
    const postingList =
      synonyms !== undefined && member.token === group.token
        ? synonyms.postings(lookup, member.token)
        : lookup(member.token)
    if (postingList === undefined) continue
    found.push({ token: member.token, factor: member.factor, partialFactor: member.partialFactor, postingList })
  }
  if (found.length === 0) return []
  const idf = computeIDF(groupDocumentFrequency, context.totalDocs)
  return found.map(entry => ({ ...entry, idf }))
}

export function groupPostingCount(matches: readonly GroupMatch[]): number {
  let total = 0
  for (const match of matches) total += match.postingList.length
  return total
}

export function computeGroupContributions(
  context: GroupScoringContext,
  matches: readonly GroupMatch[],
  collect: boolean,
): Map<number, GroupContribution> {
  const { fields, fieldNames, filterBitset, partialMarks, k1, b } = context
  const scoresAreZero = context.totalDocs === 0
  const best = new Map<number, GroupContribution>()

  for (const match of matches) {
    const perTerm = new Map<number, GroupContribution>()
    const { docIds, termFrequencies, fieldNameIndices, deletedDocs, hasDeleted, count } = postingColumns(
      match.postingList,
    )

    for (let pi = 0; pi < count; pi++) {
      const internalId = docIds[pi]
      if (hasDeleted && deletedDocs.has(internalId)) continue
      if (filterBitset && !bitsetHas(filterBitset, internalId)) continue
      const fieldIndex = fieldNameIndices[pi]
      if (fields.searchable[fieldIndex] === 0) continue
      const factor = partialMarks[fieldIndex] === 1 ? match.partialFactor : match.factor
      if (factor === 0) continue
      const fieldName = fieldNames[fieldIndex]

      const termFrequency = termFrequencies[pi]
      const fieldBoost = fields.boosts[fieldIndex]
      const avgLen = fields.averageLengths[fieldIndex]
      const actualFieldLength = fieldLengthOf(fields.lengthColumns, fieldIndex, internalId, avgLen)

      const termScore =
        (scoresAreZero ? 0 : computeBM25WithIDF(termFrequency, match.idf, actualFieldLength, avgLen, k1, b)) *
        fieldBoost *
        factor

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
