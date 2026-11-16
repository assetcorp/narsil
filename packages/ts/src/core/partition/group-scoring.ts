import type { ExpandedTermGroup, PostingListView } from '../../types/internal'
import { bitsetHas } from '../bitset'
import type { InvertedIndexReader } from '../inverted-index'
import { compareCodePoints } from '../ordering/code-points'
import { compareScores } from '../ordering/scores'
import { computeBM25WithIDF, computeIDF } from '../scorer'
import { fieldRun, orderRunByFieldName } from './field-order'
import { type FieldScoring, fieldLengthOf } from './field-scoring'
import { postingColumns } from './posting-columns'
import { addScore, beginScoring, createScoreBuffer, hasScore, type ScoreBuffer } from './score-buffer'
import type { GroupContribution, GroupMatch } from './scoring'
import type { TermCoverage } from './term-coverage'

export interface GroupScoringContext {
  index: Pick<InvertedIndexReader, 'lookup' | 'documentFrequency'>
  fields: FieldScoring
  partialMarks: Uint8Array
  fieldNames: readonly string[]
  totalDocs: number
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
      .sort(byToken)
  }
  if (!exact) {
    const matches = index.fuzzyLookup(token, tolerance, prefixLength)
    return matches.length > 1 ? matches.sort(byToken) : matches
  }
  const postingList = index.lookup(token)
  return postingList ? [{ token, postingList }] : []
}

function byToken(left: { token: string }, right: { token: string }): number {
  return compareCodePoints(left.token, right.token)
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

type MatchPostingVisit = (
  internalId: number,
  fieldIndex: number,
  termFrequency: number,
  fieldLength: number,
  termScore: number,
) => void

function scoreMatchPostings(context: GroupScoringContext, match: GroupMatch, visit: MatchPostingVisit): void {
  const { fields, filterBitset, partialMarks } = context
  const scoresAreZero = context.totalDocs === 0
  const onePair = fields.boundPairs.length === 2
  const { docIds, termFrequencies, fieldNameIndices, deletedDocs, hasDeleted, count } = postingColumns(
    match.postingList,
  )

  let runStart = 0
  let runEnd = 0
  for (let at = 0; at < count; at++) {
    const internalId = docIds[at]
    if (hasDeleted && deletedDocs.has(internalId)) continue
    if (filterBitset && !bitsetHas(filterBitset, internalId)) continue
    let pi = at
    if (at < runEnd) {
      pi = fieldRun.entries[at - runStart]
    } else if (at + 2 < count && docIds[at + 2] === internalId) {
      pi = orderRunByFieldName(docIds, fieldNameIndices, fields.nameRanks, at, count)[0]
      runStart = at
      runEnd = at + fieldRun.length
    }
    const fieldIndex = fieldNameIndices[pi]
    if (fields.searchable[fieldIndex] === 0) continue
    const factor = partialMarks[fieldIndex] === 1 ? match.partialFactor : match.factor
    if (factor === 0) continue

    const termFrequency = termFrequencies[pi]
    const fieldBoost = fields.boosts[fieldIndex]
    const avgLen = fields.averageLengths[fieldIndex]
    const actualFieldLength = fieldLengthOf(fields.lengthColumns, fieldIndex, internalId, avgLen)

    const termScore =
      (scoresAreZero
        ? 0
        : computeBM25WithIDF(
            termFrequency,
            match.idf,
            actualFieldLength,
            avgLen,
            onePair ? fields.boundPairs[0] : fields.k1s[fieldIndex],
            onePair ? fields.boundPairs[1] : fields.bs[fieldIndex],
          )) *
      fieldBoost *
      factor
    visit(internalId, fieldIndex, termFrequency, actualFieldLength, termScore)
  }
}

let termScores: ScoreBuffer | null = null
let bestScores: ScoreBuffer | null = null

export function addGroupScores(
  context: GroupScoringContext,
  matches: readonly GroupMatch[],
  target: ScoreBuffer,
  only: Uint32Array | null,
  coverage: TermCoverage | null,
): void {
  const best = bestGroupScores(context, matches, target.scores.length)
  for (let index = 0; index < best.touchedCount; index++) {
    const internalId = best.touched[index]
    if (only !== null && !bitsetHas(only, internalId)) continue
    coverage?.mark(internalId)
    addScore(target, internalId, best.scores[internalId])
  }
}

function bestGroupScores(context: GroupScoringContext, matches: readonly GroupMatch[], capacity: number): ScoreBuffer {
  termScores ??= createScoreBuffer(capacity)
  bestScores ??= createScoreBuffer(capacity)
  const perTerm = termScores
  const best = bestScores
  const addTermScore: MatchPostingVisit = (internalId, _fieldIndex, _termFrequency, _fieldLength, termScore) =>
    addScore(perTerm, internalId, termScore)
  beginScoring(best, capacity)
  for (const match of matches) {
    beginScoring(perTerm, capacity)
    scoreMatchPostings(context, match, addTermScore)
    for (let index = 0; index < perTerm.touchedCount; index++) {
      const internalId = perTerm.touched[index]
      const score = perTerm.scores[internalId]
      if (!hasScore(best, internalId)) addScore(best, internalId, score)
      else if (compareScores(score, best.scores[internalId]) < 0) best.scores[internalId] = score
    }
  }
  return best
}

export function computeGroupContributions(
  context: GroupScoringContext,
  matches: readonly GroupMatch[],
): Map<number, GroupContribution> {
  const { fieldNames } = context
  const best = new Map<number, GroupContribution>()

  for (const match of matches) {
    const perTerm = new Map<number, GroupContribution>()
    scoreMatchPostings(context, match, (internalId, fieldIndex, termFrequency, actualFieldLength, termScore) => {
      const fieldName = fieldNames[fieldIndex]
      const existing = perTerm.get(internalId)
      if (existing) {
        existing.score += termScore
        existing.termFrequencies[`${fieldName}:${match.token}`] = termFrequency
        existing.fieldLengths[fieldName] = actualFieldLength
        return
      }
      perTerm.set(internalId, {
        score: termScore,
        token: match.token,
        idf: match.idf,
        termFrequencies: { [`${fieldName}:${match.token}`]: termFrequency },
        fieldLengths: { [fieldName]: actualFieldLength },
      })
    })

    for (const [internalId, contribution] of perTerm) {
      const current = best.get(internalId)
      if (!current || compareScores(contribution.score, current.score) < 0) {
        best.set(internalId, contribution)
      }
    }
  }

  return best
}
