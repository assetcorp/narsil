import { type CorpusDocument, corpus, NEIGHBOURS, queryVectors } from '../src/corpus.ts'
import {
  checkHybrid,
  checkKeyword,
  checkVectorScores,
  exactNeighbours,
  type Finding,
  type RankedHit,
  recallAt,
} from './oracle.ts'

const KEYWORD_LIMIT = 10_000
const LONGEST_ACCEPTED_TIMER_GAP_MS = 100
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

export function checkSearch(result: Record<string, unknown>, nodeRecall: number): Checked {
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
  const hybrid = result.hybrid as Array<{ query: number; keywordHits: RankedHit[]; hits: RankedHit[] }>
  for (const answer of hybrid) {
    const depth = vector.find(entry => entry.query === answer.query)?.depthHits ?? []
    findings.push(...checkHybrid(answer.keywordHits, depth, answer.hits, `hybrid query ${answer.query}`))
  }
  const phoneRecall = mean(recall)
  if (phoneRecall < nodeRecall) {
    findings.push({ check: 'recall', detail: `phone recall ${phoneRecall} is below the Node.js recall ${nodeRecall}` })
  }
  const latency = result.latencyMs as Record<string, number[]>
  const measured: Record<string, unknown> = {
    phoneRecallAt10: phoneRecall,
    nodeRecallAt10: nodeRecall,
    insertMs: result.insertMs,
    openMs: result.openMs,
    firstQueryAfterOpenMs: result.firstQueryAfterOpenMs,
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

export function checkTimer(result: Record<string, unknown>): Checked {
  const findings: Finding[] = []
  for (const label of ['search', 'importing'] as const) {
    const work = result[label] as { workMs: number; ticks: number; longestGapMs: number }
    if (work.longestGapMs > LONGEST_ACCEPTED_TIMER_GAP_MS) {
      findings.push({ check: `timer during ${label}`, detail: `the timer paused for ${work.longestGapMs} ms` })
    }
    if (work.ticks === 0) findings.push({ check: `timer during ${label}`, detail: 'the timer never fired' })
  }
  const importing = result.importing as { imported: number; refusedCount: number }
  if (importing.imported !== result.documents || importing.refusedCount !== 0) {
    findings.push({ check: 'import', detail: `imported ${importing.imported}, refused ${importing.refusedCount}` })
  }
  return { passed: findings.length === 0, findings, measured: { search: result.search, importing: result.importing } }
}
