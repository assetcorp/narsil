import { type CorpusDocument, corpus, HYBRID_DEPTH, HYBRID_TERM, NEIGHBOURS, queryVectors } from '../src/corpus.ts'
import {
  checkHybrid,
  checkKeyword,
  checkRankedByScore,
  checkSameRanking,
  checkVectorScores,
  exactNeighbours,
  type Finding,
  type RankedHit,
  recallAt,
} from './oracle.ts'
import { checkSearchUnderWrites, type UnderWrites } from './under-writes.ts'

const KEYWORD_LIMIT = 10_000
const LONGEST_ACCEPTED_TIMER_GAP_MS = 500
const MIN_RECALL_AT_10 = 0.99
const TIMED_WRITE_BATCH = 2_000
const TIMED_PATHS = [
  'inserting',
  'insertingInMemory',
  'search',
  'vectorSearch',
  'updating',
  'importing',
  'removing',
] as const
const MEMORY_WRITE_BLOCKED = 'MEMORY_WRITE_BLOCKED'

export interface Checked {
  passed: boolean
  findings: Finding[]
  measured: Record<string, unknown>
}

interface RaisedError {
  raised: boolean
  typed: boolean
  code: string | null
}

const documents: CorpusDocument[] = corpus()
const byId = new Map(documents.map(document => [document.id, document]))
const queries = queryVectors()

function mean(values: readonly number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length)
}

function percentile(values: readonly number[], share: number): number {
  const sorted = [...values].sort((left, right) => left - right)
  return sorted[Math.min(sorted.length - 1, Math.floor(share * sorted.length))] ?? Number.NaN
}

function vectorRecall(answers: ReadonlyArray<{ query: number; hits: RankedHit[] }>, findings: Finding[]): number[] {
  return answers.map(answer => {
    const query = queries[answer.query]
    if (query === undefined) {
      findings.push({ check: 'vector', detail: `query ${answer.query} is unknown` })
      return 0
    }
    findings.push(...checkVectorScores(byId, query, answer.hits, `vector query ${answer.query}`))
    return recallAt(answer.hits, exactNeighbours(documents, query, NEIGHBOURS))
  })
}

type QueryAnswers = ReadonlyArray<{ query: number; hits: RankedHit[] }>

export interface SearchReference {
  recallAt10: number
  vector: QueryAnswers
  hybrid: QueryAnswers
}

function sameRankings(expected: QueryAnswers, got: QueryAnswers, label: string): Finding[] {
  const findings: Finding[] = []
  if (got.length !== expected.length) {
    findings.push({
      check: label,
      detail: `the phone answered ${got.length} queries, the restored snapshot ${expected.length}`,
    })
  }
  for (const answer of got) {
    const reference = expected.find(entry => entry.query === answer.query)
    if (reference === undefined) {
      findings.push({ check: `${label} query ${answer.query}`, detail: 'the restored snapshot gave no answer for it' })
      continue
    }
    findings.push(...checkSameRanking(reference.hits, answer.hits, `${label} query ${answer.query}`))
  }
  return findings
}

type FullPrecisionAnswers = ReadonlyArray<{ query: number; depthHits: RankedHit[]; hits: RankedHit[] }>

function hybridAgainstFusion(answers: FullPrecisionAnswers | undefined): Finding[] {
  if (answers === undefined || answers.length !== queries.length) {
    return [
      { check: 'hybrid fusion', detail: `the phone answered ${answers?.length ?? 0} of ${queries.length} queries` },
    ]
  }
  const findings: Finding[] = []
  for (const answer of answers) {
    const query = queries[answer.query]
    const label = `hybrid fusion ${answer.query}`
    if (query === undefined) {
      findings.push({ check: label, detail: 'the query is unknown' })
      continue
    }
    findings.push(...checkVectorScores(byId, query, answer.depthHits, `${label} vector list`))
    findings.push(...checkRankedByScore(answer.depthHits, `${label} vector list`))
    findings.push(...checkHybrid(documents, HYBRID_TERM, answer.depthHits, answer.hits, HYBRID_DEPTH, label))
  }
  return findings
}

export function checkSearch(
  result: Record<string, unknown>,
  reference: SearchReference,
  nodeBuiltRecallAt10: number,
): Checked {
  const findings: Finding[] = []
  const keyword = result.keyword as Array<{ term: string; count: number; hits: RankedHit[] }>
  findings.push(...checkKeyword(documents, keyword, KEYWORD_LIMIT))
  const vector = result.vector as Array<{ query: number; hits: RankedHit[]; depthHits: RankedHit[] }>
  const recall = vectorRecall(vector, findings)
  for (const answer of vector) {
    const query = queries[answer.query]
    if (query !== undefined) {
      findings.push(...checkVectorScores(byId, query, answer.depthHits, `vector depth ${answer.query}`))
    }
  }
  const hybrid = result.hybrid as QueryAnswers
  findings.push(...hybridAgainstFusion(result.fullPrecisionHybrid as FullPrecisionAnswers | undefined))
  findings.push(...sameRankings(reference.vector, vector, 'vector'))
  findings.push(...sameRankings(reference.hybrid, hybrid, 'hybrid'))
  const underWrites = checkSearchUnderWrites(result.underWrites as UnderWrites | undefined)
  findings.push(...underWrites.findings)
  const phoneRecall = mean(recall)
  if (phoneRecall < MIN_RECALL_AT_10) {
    findings.push({ check: 'recall', detail: `phone recall ${phoneRecall} is below ${MIN_RECALL_AT_10}` })
  }
  if (phoneRecall < nodeBuiltRecallAt10) {
    findings.push({
      check: 'recall against Node.js',
      detail: `phone recall ${phoneRecall} is below the ${nodeBuiltRecallAt10} of an index that Node.js builds from the same corpus`,
    })
  }
  const latency = result.latencyMs as Record<string, number[]>
  const measured: Record<string, unknown> = {
    phoneRecallAt10: phoneRecall,
    restoredOnNodeRecallAt10: reference.recallAt10,
    builtOnNodeRecallAt10: nodeBuiltRecallAt10,
    insertMs: result.insertMs,
    openMs: result.openMs,
    firstQueryAfterOpenMs: result.firstQueryAfterOpenMs,
    queriesUnderWrites: underWrites.queries,
    queriesOverlappingWrites: underWrites.queriesOverlappingWrites,
    memory: result.memory,
  }
  for (const [kind, values] of Object.entries(latency)) {
    measured[`${kind}LatencyMs`] = { p50: percentile(values, 0.5), p95: percentile(values, 0.95), runs: values.length }
  }
  return { passed: findings.length === 0, findings, measured }
}

export function checkRestoredSnapshot(result: Record<string, unknown>): Checked {
  const findings: Finding[] = []
  const ids = new Set(result.ids as string[])
  const missing = documents.filter(document => !ids.has(document.id)).length
  if (missing > 0 || ids.size !== documents.length) {
    findings.push({ check: 'snapshot ids', detail: `${ids.size} ids, ${missing} corpus documents missing` })
  }
  findings.push(...checkKeyword(documents, result.keyword as Array<{ term: string; hits: RankedHit[] }>, NEIGHBOURS))
  const recall = vectorRecall(result.vector as Array<{ query: number; hits: RankedHit[] }>, findings)
  return {
    passed: findings.length === 0,
    findings,
    measured: { restoreMs: result.restoreMs, recallAt10: mean(recall) },
  }
}

function requireTyped(findings: Finding[], label: string, error: RaisedError, code?: string): void {
  if (!error.raised) findings.push({ check: label, detail: 'raised no error' })
  else if (!error.typed) findings.push({ check: label, detail: `raised an untyped error with code ${error.code}` })
  else if (code !== undefined && error.code !== code) {
    findings.push({ check: label, detail: `raised ${error.code}, expected ${code}` })
  }
}

export function checkErrors(result: Record<string, unknown>): Checked {
  const findings: Finding[] = []
  const failures = (result.stepFailures ?? []) as Array<{
    step: string
    error: RaisedError & { message: string | null }
  }>
  for (const failure of failures) {
    findings.push({ check: `step ${failure.step}`, detail: `threw ${failure.error.code}: ${failure.error.message}` })
  }
  const checkpoint = result.damagedCheckpoint as { error: RaisedError } | undefined
  if (checkpoint !== undefined) requireTyped(findings, 'checkpoint cut short', checkpoint.error)
  const snapshot = result.damagedSnapshot as { truncated: RaisedError; flipped: RaisedError } | undefined
  if (snapshot !== undefined) {
    requireTyped(findings, 'snapshot cut short', snapshot.truncated)
    requireTyped(findings, 'snapshot with a flipped byte', snapshot.flipped)
  }
  const vectors = (result.invalidVectors ?? {}) as Record<string, RaisedError>
  for (const [label, error] of Object.entries(vectors)) requireTyped(findings, `vector ${label}`, error)
  const memory = result.memoryLimit as ({ error: RaisedError } & Record<string, unknown>) | undefined
  if (memory !== undefined) requireTyped(findings, 'index past the memory limit', memory.error, MEMORY_WRITE_BLOCKED)
  if (result.appStillAnswers !== true) findings.push({ check: 'app afterwards', detail: 'the app stopped answering' })
  return {
    passed: findings.length === 0,
    findings,
    measured: {
      checkpointCode: checkpoint?.error.code ?? null,
      snapshotCodes: snapshot === undefined ? null : [snapshot.truncated.code, snapshot.flipped.code],
      vectorCodes: Object.fromEntries(Object.entries(vectors).map(([label, error]) => [label, error.code])),
      memory: memory ?? null,
      memoryLimitProgress: result.memoryLimitProgress ?? null,
    },
  }
}

interface TimedPath {
  workMs: number
  ticks: number
  longestGapMs: number
  longestBusyMs: number | null
  tickGaps: Array<{ startMs: number; ms: number; longestBusyMs: number }>
}

function checkTimedPath(label: string, work: TimedPath): Finding[] {
  const check = `timer during ${label}`
  if (work.ticks === 0) return [{ check, detail: 'the timer never fired' }]
  if (!(work.longestGapMs <= LONGEST_ACCEPTED_TIMER_GAP_MS)) {
    return [{ check, detail: `the timer waited ${work.longestGapMs.toFixed(1)} ms between two ticks` }]
  }
  return []
}

export function checkTimer(result: Record<string, unknown>): Checked {
  const findings: Finding[] = []
  for (const label of TIMED_PATHS) findings.push(...checkTimedPath(label, result[label] as TimedPath))
  const importing = result.importing as { imported: number; refusedCount: number }
  if (importing.imported !== result.documents || importing.refusedCount !== 0) {
    findings.push({ check: 'import', detail: `imported ${importing.imported}, refused ${importing.refusedCount}` })
  }
  const updated = (result.updating as { updated: number }).updated
  const removed = (result.removing as { removed: number }).removed
  if (updated !== TIMED_WRITE_BATCH || removed !== TIMED_WRITE_BATCH) {
    findings.push({ check: 'timed writes', detail: `updated ${updated}, removed ${removed}` })
  }
  return {
    passed: findings.length === 0,
    findings,
    measured: Object.fromEntries(['idle', ...TIMED_PATHS].map(label => [label, result[label]])),
  }
}
