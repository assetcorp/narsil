import type { PostingListView } from '../../types/internal'

export const EMPTY_COMPONENTS: Record<string, number> = Object.freeze({})

/**
 * The per-document scoring record a query keeps only where the caller asked to
 * see score components or set a term-coverage policy.
 *
 * @internal
 */
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

/**
 * Folds a prefix expansion's winning contribution into a document's score
 * components.
 *
 * @param components - The records collected so far in this query.
 * @param internalId - The internal id of the document that matched.
 * @param contribution - The best-scoring expanded term for that document.
 */
export function mergePrefixComponents(
  components: Map<number, ScoreComponents>,
  internalId: number,
  contribution: PrefixContribution,
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
  isPrefix?: boolean
}

export interface PrefixMatch {
  token: string
  factor: number
  postingList: PostingListView
  docFreq: number
  idf: number
}

export interface PrefixContribution {
  score: number
  token: string
  idf: number
  termFrequencies: Record<string, number>
  fieldLengths: Record<string, number>
}
