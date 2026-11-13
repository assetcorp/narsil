import { spawn, spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ensureOracle } from '../oracle'
import { ORACLE_PYTHON, ORACLE_ROOT, SUITE_ROOT } from '../paths'
import { KEYWORD_QUERIES_FILE } from '../workload/format'
import { workloadSettings } from '../workload/settings'
import { writeWorkload } from '../workload/write'

const VOCABULARY_SIZE = 240
const KEYWORD_DOCUMENTS = 1_200
const KEYWORD_QUERIES = 30
const VECTOR_DOCUMENTS = 1_200
const VECTOR_QUERIES = 40
const DIMENSION = 16
const WORDS_PER_BODY = 24
const THREAD_COUNTS = '1,8'
const EXPECTED_MEASUREMENTS = 12
const ORACLE_FAILED = 1
const DISTINCT_SCORE_GAP = 1e-6

type RunnerHit = [string, number]

interface RunnerAnswer {
  count: number
  countExact: boolean
  hits: RunnerHit[]
}

interface RunnerFile {
  verification: Record<string, RunnerAnswer[]>
}

function seededRandom(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state)
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4_294_967_296
  }
}

const random = seededRandom(20_261_113)
const vocabulary = Array.from({ length: VOCABULARY_SIZE }, (_, index) => `lantern${index.toString(36)}harbour`)

function words(count: number): string {
  return Array.from({ length: count }, () => vocabulary[Math.floor(random() * VOCABULARY_SIZE)]).join(' ')
}

function vectors(rows: number): Float32Array {
  return Float32Array.from({ length: rows * DIMENSION }, () => random() * 2 - 1)
}

function textDocuments(count: number, prefix: string) {
  return Array.from({ length: count }, (_, index) => ({
    id: `${prefix}-${index}`,
    title: words(3),
    body: words(WORDS_PER_BODY),
  }))
}

let scratch = ''
let workload = ''
let firstRun: { status: number | null; output: string; staging: string }

function runDriver(args: readonly string[], outputRoot: string) {
  const result = spawnSync(
    process.execPath,
    ['--import', 'tsx', resolve(SUITE_ROOT, 'src', 'run.ts'), ...args, '--output-root', outputRoot],
    {
      cwd: SUITE_ROOT,
      env: { ...process.env, BENCH_PROFILE: 'smoke' },
      encoding: 'utf-8',
      maxBuffer: 64 * 1024 * 1024,
      timeout: 120_000,
    },
  )
  const output = `${result.stdout}\n${result.stderr}`
  const staging = /Runner outputs go to (\S+)/.exec(output)?.[1] ?? ''
  return { status: result.status, output, staging }
}

function runOracle(outputs: readonly string[], directory = workload) {
  const result = spawnSync(
    ORACLE_PYTHON,
    [
      '-m',
      'engine_languages_oracle',
      '--workload',
      directory,
      '--truth',
      resolve(scratch, 'truth.json'),
      '--verdict',
      resolve(scratch, 'tampered-verdict.json'),
      ...outputs,
    ],
    { cwd: ORACLE_ROOT, encoding: 'utf-8' },
  )
  return { status: result.status, output: `${result.stdout}\n${result.stderr}` }
}

function tampered(name: string, change: (file: RunnerFile) => void): string {
  const file = JSON.parse(readFileSync(resolve(firstRun.staging, name), 'utf-8')) as RunnerFile
  change(file)
  const path = resolve(scratch, `tampered-${name}`)
  writeFileSync(path, JSON.stringify(file))
  return path
}

function runDirectories(outputRoot: string): string[] {
  const root = resolve(outputRoot, 'results', '.smoke', 'runs')
  return existsSync(root) ? readdirSync(root) : []
}

beforeAll(async () => {
  scratch = mkdtempSync(resolve(tmpdir(), 'narsil-engine-languages-'))
  workload = resolve(scratch, 'workload')
  await writeWorkload(workload, {
    keyword: {
      dataset: 'synthetic-keyword',
      documents: textDocuments(KEYWORD_DOCUMENTS, 'keyword'),
      queries: Array.from({ length: KEYWORD_QUERIES }, (_, index) => words(1 + (index % 3))),
    },
    vector: {
      dataset: 'synthetic-vector',
      model: 'uniform random',
      dimension: DIMENSION,
      documents: textDocuments(VECTOR_DOCUMENTS, 'vector'),
      documentVectors: vectors(VECTOR_DOCUMENTS),
      queries: Array.from({ length: VECTOR_QUERIES }, (_, index) => ({ id: `query-${index}`, text: words(4) })),
      queryVectors: vectors(VECTOR_QUERIES),
    },
    settings: workloadSettings('small'),
  })
  await ensureOracle()
  firstRun = runDriver(
    ['--workload', workload, '--threads', THREAD_COUNTS, '--repetitions', '1', '--keep-outputs'],
    resolve(scratch, 'published'),
  )
})

afterAll(() => {
  if (scratch !== '') rmSync(scratch, { recursive: true, force: true })
  if (firstRun?.staging) rmSync(firstRun.staging, { recursive: true, force: true })
})

describe('the engine-languages benchmark', () => {
  it('records a run only after the oracle accepts every answer from all three engines', () => {
    expect(firstRun.output).toContain('Every answer matched the oracle')
    expect(firstRun.status).toBe(0)
    const [runId] = runDirectories(resolve(scratch, 'published'))
    expect(runId).toBeDefined()
    const runDirectory = resolve(scratch, 'published', 'results', '.smoke', 'runs', String(runId))
    const results = JSON.parse(readFileSync(resolve(runDirectory, 'results.json'), 'utf-8')) as {
      measurements: Array<{ engine: string; workload: string; threads: number; quality: { recall10: number | null } }>
    }
    expect(results.measurements).toHaveLength(EXPECTED_MEASUREMENTS)
    expect(new Set(results.measurements.map(entry => entry.engine))).toEqual(new Set(['typescript', 'rust', 'go']))
    for (const entry of results.measurements.filter(measurement => measurement.workload === 'vector')) {
      expect(entry.quality.recall10).toBeGreaterThanOrEqual(0.95)
    }
    expect(existsSync(resolve(runDirectory, 'report.md'))).toBe(true)
  })

  it('fails a runner whose keyword ranking swaps two hits with different scores', () => {
    const path = tampered('rep-1-rust-keyword-1.json', file => {
      const answer = file.verification.keyword?.find(candidate => {
        const [first, second] = candidate.hits
        return first !== undefined && second !== undefined && first[1] - second[1] > DISTINCT_SCORE_GAP
      })
      const [first, second] = answer?.hits ?? []
      if (answer === undefined || first === undefined || second === undefined) {
        throw new Error('no keyword answer ranks two hits with different scores')
      }
      answer.hits[0] = second
      answer.hits[1] = first
    })
    const result = runOracle([path])
    expect(result.status).toBe(ORACLE_FAILED)
    expect(result.output).toContain('keyword query')
  })

  it('fails a runner whose vector answers fall below the recall floor while every score stays exact', () => {
    const path = tampered('rep-1-go-vector-1.json', file => {
      const top = file.verification.vector ?? []
      const deep = file.verification.vectorDeep ?? []
      top.forEach((answer, query) => {
        answer.hits = (deep[query]?.hits ?? []).slice(-answer.hits.length)
      })
    })
    const result = runOracle([path])
    expect(result.status).toBe(ORACLE_FAILED)
    expect(result.output).toContain("below the specification's floor")
  })

  it('fails a runner whose hybrid count disagrees with its two fused legs', () => {
    const path = tampered('rep-1-typescript-vector-8.json', file => {
      const answer = file.verification.hybrid?.[0]
      if (answer === undefined) throw new Error('no hybrid answer')
      answer.count += 1
    })
    const result = runOracle([path])
    expect(result.status).toBe(ORACLE_FAILED)
    expect(result.output).toContain('hybrid query 0 counts')
  })

  it('refuses a workload whose file no longer matches its manifest and records no run', () => {
    const damaged = resolve(scratch, 'damaged')
    cpSync(workload, damaged, { recursive: true })
    const queries = resolve(damaged, KEYWORD_QUERIES_FILE)
    writeFileSync(queries, readFileSync(queries, 'utf-8').replace('lantern', 'lanterm'))
    const outputRoot = resolve(scratch, 'refused')
    const result = runDriver(['--workload', damaged, '--threads', '1', '--repetitions', '1'], outputRoot)
    expect(result.status).not.toBe(0)
    expect(result.output).toContain(`workload file ${KEYWORD_QUERIES_FILE} has sha256`)
    expect(runDirectories(outputRoot)).toEqual([])
  })

  it('allows final-bit score rounding but rejects a larger score error', () => {
    const close = tampered('rep-1-rust-keyword-1.json', file => {
      for (const answer of file.verification.keyword ?? []) {
        for (const hit of answer.hits) hit[1] *= 1 + Number.EPSILON
      }
    })
    expect(runOracle([close]).status).toBe(0)
    const wrong = tampered('rep-1-rust-keyword-1.json', file => {
      for (const answer of file.verification.keyword ?? []) {
        for (const hit of answer.hits) hit[1] *= 1 + 1e-10
      }
    })
    expect(runOracle([wrong]).status).toBe(1)
  })

  it('rebuilds truncated and corrupted truth caches without trusting their answers', () => {
    const output = resolve(firstRun.staging, 'rep-1-rust-keyword-1.json')
    expect(runOracle([output]).status).toBe(0)
    const truth = resolve(scratch, 'truth.json')
    const cached = JSON.parse(readFileSync(truth, 'utf-8'))
    cached.payload.keyword[0].count += 1
    writeFileSync(truth, JSON.stringify(cached))
    expect(runOracle([output]).status).toBe(0)
    writeFileSync(truth, '{')
    expect(runOracle([output]).status).toBe(0)
  })

  it('rechecks workload digests before using cached truth', () => {
    const damaged = resolve(scratch, 'oracle-damaged')
    cpSync(workload, damaged, { recursive: true })
    writeFileSync(resolve(damaged, KEYWORD_QUERIES_FILE), '{"text":"other"}\n'.repeat(KEYWORD_QUERIES))
    const result = runOracle([resolve(firstRun.staging, 'rep-1-rust-keyword-1.json')], damaged)
    expect(result.status).toBe(2)
    expect(result.output).toContain('different sha256')
  })

  it('keeps an interrupted repetition unpublished and restarts without reusing its outputs', async () => {
    const root = resolve(scratch, 'interrupted')
    const args = ['--workload', workload, '--engines', 'typescript', '--threads', '1', '--repetitions', '2']
    let output = ''
    const status = await new Promise<number | null>((done, fail) => {
      const child = spawn(
        process.execPath,
        ['--import', 'tsx', resolve(SUITE_ROOT, 'src/run.ts'), ...args, '--output-root', root],
        { cwd: SUITE_ROOT, env: { ...process.env, BENCH_PROFILE: 'smoke' }, stdio: ['ignore', 'pipe', 'pipe'] },
      )
      const timer = setTimeout(() => {
        child.kill('SIGTERM')
        fail(new Error('the interrupted run did not finish'))
      }, 60_000)
      child.stdout.on('data', chunk => {
        output += String(chunk)
        if (output.includes('Repetition 2 of 2')) child.kill('SIGTERM')
      })
      child.stderr.on('data', () => undefined)
      child.on('error', fail)
      child.on('close', code => {
        clearTimeout(timer)
        done(code)
      })
    })
    const abandoned = /Runner outputs go to (\S+)/.exec(output)?.[1]
    try {
      expect(status).not.toBe(0)
      expect(output).toContain('Repetition 2 of 2')
      expect(runDirectories(root)).toEqual([])
      const restarted = runDriver(
        ['--workload', workload, '--engines', 'typescript', '--threads', '1', '--repetitions', '1'],
        root,
      )
      expect(restarted.status, restarted.output).toBe(0)
      expect(restarted.staging).not.toBe(abandoned)
      expect(existsSync(restarted.staging)).toBe(false)
      expect(runDirectories(root)).toHaveLength(1)
    } finally {
      if (abandoned) rmSync(abandoned, { recursive: true, force: true })
    }
  })
})
