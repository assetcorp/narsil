import type { QueryHit } from '../backend'
import type { AggregateMetrics, BenchmarkResult, QueryMetrics, RelevanceMap } from './metrics'
import { averagePrecision, ndcgAtK, precisionAtK, reciprocalRank } from './metrics'

export const JUDGING_POOL_DEPTH = 100

export const RANK_CUTOFF = 10

const STORAGE_KEY = 'narsil-judged-questions'

export type RelevanceGrade = 0 | 1

export interface JudgedQuestion {
  id: number
  text: string
  judgments: Record<string, RelevanceGrade>
}

export function hitDocumentId(hit: QueryHit): string {
  return String(hit.document.id ?? hit.id)
}

export function nextQuestionId(questions: readonly JudgedQuestion[]): number {
  let highest = 0
  for (const question of questions) {
    if (question.id > highest) highest = question.id
  }
  return highest + 1
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseQuestion(value: unknown): JudgedQuestion | null {
  if (!isRecord(value)) return null
  if (typeof value.id !== 'number' || !Number.isInteger(value.id) || value.id < 1) return null
  if (typeof value.text !== 'string' || value.text.trim().length === 0) return null
  if (!isRecord(value.judgments)) return null

  const judgments: Record<string, RelevanceGrade> = {}
  for (const [documentId, grade] of Object.entries(value.judgments)) {
    if (grade === 0 || grade === 1) judgments[documentId] = grade
  }

  return { id: value.id, text: value.text, judgments }
}

function parseQuestions(value: unknown): JudgedQuestion[] {
  if (!Array.isArray(value)) return []
  const questions: JudgedQuestion[] = []
  const seenIds = new Set<number>()
  for (const entry of value) {
    const question = parseQuestion(entry)
    if (question === null || seenIds.has(question.id)) continue
    seenIds.add(question.id)
    questions.push(question)
  }
  return questions
}

function readAllSessions(): Record<string, unknown> {
  if (typeof window === 'undefined') return {}
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (raw === null) return {}
  try {
    const parsed: unknown = JSON.parse(raw)
    return isRecord(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

function writeAllSessions(sessions: Record<string, unknown>): void {
  if (typeof window === 'undefined') return
  if (Object.keys(sessions).length === 0) {
    window.localStorage.removeItem(STORAGE_KEY)
    return
  }
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(sessions))
}

export function readJudgedQuestions(indexName: string): JudgedQuestion[] {
  return parseQuestions(readAllSessions()[indexName])
}

export function writeJudgedQuestions(indexName: string, questions: readonly JudgedQuestion[]): void {
  const sessions = readAllSessions()
  if (questions.length === 0) {
    if (!(indexName in sessions)) return
    delete sessions[indexName]
  } else {
    sessions[indexName] = questions
  }
  writeAllSessions(sessions)
}

export function deleteJudgedQuestions(indexName: string): void {
  writeJudgedQuestions(indexName, [])
}

function toRelevanceMap(judgments: Record<string, RelevanceGrade>): RelevanceMap {
  const map: RelevanceMap = new Map()
  for (const [documentId, grade] of Object.entries(judgments)) {
    map.set(documentId, grade)
  }
  return map
}

function aggregate(perQuery: readonly QueryMetrics[]): AggregateMetrics {
  const total = perQuery.length
  let sumNdcg10 = 0
  let sumPrecision10 = 0
  let sumAp = 0
  let sumRr = 0

  for (const query of perQuery) {
    sumNdcg10 += query.ndcg10
    sumPrecision10 += query.precision10
    sumAp += query.ap
    sumRr += query.rr
  }

  return {
    meanNdcg10: sumNdcg10 / total,
    meanPrecision10: sumPrecision10 / total,
    map: sumAp / total,
    mrr: sumRr / total,
    queriesEvaluated: total,
  }
}

export function measureJudgedQuestion(question: JudgedQuestion, ranked: readonly string[]): QueryMetrics {
  const judgments = toRelevanceMap(question.judgments)
  const totalRelevant = Array.from(judgments.values()).filter(grade => grade > 0).length
  const resultIds = [...ranked]

  return {
    queryId: question.id,
    queryText: question.text,
    ndcg10: ndcgAtK(resultIds, judgments, RANK_CUTOFF),
    precision10: precisionAtK(resultIds, judgments, RANK_CUTOFF),
    ap: averagePrecision(resultIds, judgments, totalRelevant),
    rr: reciprocalRank(resultIds, judgments),
    resultIds,
    judgments,
  }
}

export function evaluateJudgedQuestions(
  questions: readonly JudgedQuestion[],
  rankedByQuestion: ReadonlyMap<number, string[]>,
): BenchmarkResult | null {
  const perQuery: QueryMetrics[] = []

  for (const question of questions) {
    const ranked = rankedByQuestion.get(question.id)
    if (ranked === undefined) continue
    if (Object.keys(question.judgments).length === 0) continue
    perQuery.push(measureJudgedQuestion(question, ranked))
  }

  if (perQuery.length === 0) return null
  return { aggregate: aggregate(perQuery), perQuery }
}
