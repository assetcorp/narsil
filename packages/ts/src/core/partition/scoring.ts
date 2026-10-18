import type { PostingListView } from '../../types/internal'

export const EMPTY_COMPONENTS: Record<string, number> = Object.freeze({})

export interface ScoreComponents {
  termFrequencies: Record<string, number>
  fieldLengths: Record<string, number>
  idf: Record<string, number>
}

/**
 * Records one term's contribution to a document's score components.
 *
 * @param components - The records collected so far in this query.
 * @param internalId - The internal id of the document that matched.
 * @param fieldName - The field the term was found in.
 * @param token - The index term that matched.
 * @param termFrequency - How often the term occurs in that field.
 * @param fieldLength - The length of that field in the document.
 * @param idf - The inverse document frequency used for the term.
 */
export function recordComponents(
  components: Map<number, ScoreComponents>,
  internalId: number,
  fieldName: string,
  token: string,
  termFrequency: number,
  fieldLength: number,
  idf: number,
): void {
  const existing = components.get(internalId)
  if (existing) {
    existing.termFrequencies[`${fieldName}:${token}`] = termFrequency
    existing.fieldLengths[fieldName] = fieldLength
    existing.idf[token] = idf
    return
  }
  components.set(internalId, {
    termFrequencies: { [`${fieldName}:${token}`]: termFrequency },
    fieldLengths: { [fieldName]: fieldLength },
    idf: { [token]: idf },
  })
}

export function mergeGroupComponents(
  components: Map<number, ScoreComponents>,
  internalId: number,
  contribution: GroupContribution,
): void {
  const existing = components.get(internalId)
  if (existing) {
    Object.assign(existing.termFrequencies, contribution.termFrequencies)
    Object.assign(existing.fieldLengths, contribution.fieldLengths)
    existing.idf[contribution.token] = contribution.idf
    return
  }
  components.set(internalId, {
    termFrequencies: contribution.termFrequencies,
    fieldLengths: contribution.fieldLengths,
    idf: { [contribution.token]: contribution.idf },
  })
}

export interface ResolvedTokenPostings {
  token: string
  matches: Array<{
    token: string
    docFreq: number
    idf: number
    postingList: PostingListView
  }>
  totalPostings: number
  group: GroupMatch[] | null
}

export interface GroupMatch {
  token: string
  factor: number
  partialFactor: number
  postingList: PostingListView
  idf: number
}

export interface GroupContribution {
  score: number
  token: string
  idf: number
  termFrequencies: Record<string, number>
  fieldLengths: Record<string, number>
}
