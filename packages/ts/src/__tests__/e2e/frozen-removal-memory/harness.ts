import { spawn } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect } from 'vitest'
import type { AnyDocument } from '../../../types/schema'
import { INDEX, workshopBootstrapModule, workshopCorpus } from '../partial-words/corpus'
import { expectSameHits, probeQueries, RESULT_LIMIT, WORKSHOP_INDEX_CONFIG } from '../partial-words/harness'
import { createOracle, type OracleHit, type OracleQuery } from '../partial-words/oracle'

export const REMOVAL_PROCESS_SCRIPT = fileURLToPath(new URL('./removal-process.mjs', import.meta.url))
export const REPOSITORY_ROOT = fileURLToPath(new URL('../../../../../../', import.meta.url))
const JOB_FILE = 'job.json'
const RESULT_FILE = 'result.json'

export type MemoryFill = { kind: 'heap'; limitBytes: number; fraction: number } | { kind: 'resident'; fraction: number }

export interface RemovalPlan {
  documents: AnyDocument[]
  removalBatches: string[][]
  releaseFillBefore: number
  queries: OracleQuery[]
}

export interface RemovalPhase {
  failed: unknown[]
  estimatedMemoryBytes: number
  residentBytes: number
  answers: OracleHit[][]
}

export interface RemovalOutcome {
  loadedBytes: number
  filledResidentBytes: number
  filledHeapBytes: number
  processLimitBytes: number | null
  counted: number
  phases: RemovalPhase[]
}

const ONLY_IN_EARLY_BATCHES = 'zyxonly'
const IN_EVERY_BATCH = 'zyxlast'
const KEPT_AFTER_EVERY_BATCH = 'zyxkept'
const KEPT_MARKER_STRIDE = 50
const LATE_BATCH = 2
const MARKER_QUERIES: readonly OracleQuery[] = [
  ...[ONLY_IN_EARLY_BATCHES, IN_EVERY_BATCH, KEPT_AFTER_EVERY_BATCH].flatMap((term): OracleQuery[] => [
    { term, partialWords: false },
    { term, partialWords: false, fields: ['body'] },
  ]),
  { term: `${KEPT_AFTER_EVERY_BATCH} water`, partialWords: false },
  { term: `${IN_EVERY_BATCH} ${KEPT_AFTER_EVERY_BATCH}`, partialWords: false, termMatch: 'all' },
  { term: `${ONLY_IN_EARLY_BATCHES} ${KEPT_AFTER_EVERY_BATCH}`, partialWords: false },
]

function markersOf(batch: number | undefined, at: number): string[] {
  if (batch === undefined) return at % KEPT_MARKER_STRIDE === 0 ? [KEPT_AFTER_EVERY_BATCH] : []
  const shared = at % 2 === 0 ? [IN_EVERY_BATCH, KEPT_AFTER_EVERY_BATCH] : []
  return batch < LATE_BATCH ? [ONLY_IN_EARLY_BATCHES, ...shared] : shared
}

export function removalPlan(documentCount: number, batchDocuments: number, batches: number): RemovalPlan {
  const corpus = workshopCorpus(documentCount, 53)
  const batchOf = new Map<number, number>()
  const removalBatches: string[][] = []
  for (let batch = 0; batch < batches; batch++) {
    const docIds: string[] = []
    for (let at = batch; at < corpus.length && docIds.length < batchDocuments; at += batches * 3) {
      docIds.push(String(corpus[at].id))
      batchOf.set(at, batch)
    }
    removalBatches.push(docIds)
  }
  const documents = corpus.map((document, at) => {
    const markers = markersOf(batchOf.get(at), at)
    return markers.length === 0 ? document : { ...document, body: `${String(document.body)} ${markers.join(' ')}` }
  })
  return { documents, removalBatches, releaseFillBefore: batches, queries: [...probeQueries(), ...MARKER_QUERIES] }
}

export async function writeRemovalJob(workDirectory: string, plan: RemovalPlan, fill: MemoryFill): Promise<string> {
  const jobPath = join(workDirectory, JOB_FILE)
  const job = {
    bootstrapModule: workshopBootstrapModule(),
    directory: join(workDirectory, 'index'),
    indexName: INDEX,
    indexConfig: WORKSHOP_INDEX_CONFIG,
    documents: plan.documents,
    removalBatches: plan.removalBatches,
    releaseFillBefore: plan.releaseFillBefore,
    queries: plan.queries,
    resultLimit: RESULT_LIMIT,
    fill,
    resultPath: join(workDirectory, RESULT_FILE),
  }
  await writeFile(jobPath, JSON.stringify(job))
  return jobPath
}

export async function readRemovalOutcome(workDirectory: string): Promise<RemovalOutcome> {
  const resultPath = join(workDirectory, RESULT_FILE)
  const outcome = JSON.parse(await readFile(resultPath, 'utf8')) as Omit<RemovalOutcome, 'phases'> & {
    phases: Omit<RemovalPhase, 'answers'>[]
  }
  const phases: RemovalPhase[] = []
  for (const [at, phase] of outcome.phases.entries()) {
    const answers = JSON.parse(await readFile(`${resultPath}.phase-${at}`, 'utf8')) as OracleHit[][]
    phases.push({ ...phase, answers })
  }
  return { ...outcome, phases }
}

export async function runCommand(command: string, args: string[]): Promise<{ code: number | null; output: string }> {
  return await new Promise(resolve => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, NODE_OPTIONS: '' } })
    let output = ''
    child.stdout.on('data', (chunk: Buffer) => {
      output += chunk.toString()
    })
    child.stderr.on('data', (chunk: Buffer) => {
      output += chunk.toString()
    })
    child.once('error', error => resolve({ code: null, output: `${output}\n${error.message}` }))
    child.once('exit', code => resolve({ code, output }))
  })
}

export function expectEveryPhaseMatchesOracle(plan: RemovalPlan, outcome: RemovalOutcome): void {
  const held = new Map(plan.documents.map(document => [String(document.id), document]))
  outcome.phases.forEach((phase, at) => {
    expect(phase.failed, `batch ${at}`).toEqual([])
    for (const docId of plan.removalBatches[at]) held.delete(docId)
    const oracle = createOracle([...held.values()])
    plan.queries.forEach((query, queryAt) => {
      expectSameHits(phase.answers[queryAt], oracle.search(query), `batch ${at} ${JSON.stringify(query)}`)
    })
  })
  expect(outcome.counted).toBe(held.size)
}
