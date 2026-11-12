import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createNarsil, type Narsil } from '../../../narsil'
import { bodyOf, expectDocumentsOf, expectFiguresMatchTheFiles, savedBytesAllowedFor } from './saved-size-oracle'

const CHILD_SCRIPT = fileURLToPath(new URL('./removed-rewrite-crash-child.mjs', import.meta.url))
const BUILT = existsSync(new URL('../../../../dist/index.mjs', import.meta.url))
const INDEX = 'notes'
const DOCUMENTS = 3000
const BODY_LENGTH = 600
const CHILD_TIMEOUT_MS = 60_000
const KILL_POINTS = ['segment-1', 'segment-2', 'manifest']
const WROTE_SEGMENT = /^WROTE s\d{16}$/

function reachedKillPoint(lines: string[], killAt: string): boolean {
  if (killAt === 'manifest') return lines.includes('WROTE manifest')
  const segmentsWritten = lines.filter(line => WROTE_SEGMENT.test(line)).length
  return segmentsWritten === Number(killAt.slice('segment-'.length)) && !lines.includes('WROTE manifest')
}

function runUntilKilled(directory: string, killAt: string): Promise<number> {
  const child = spawn(process.execPath, [CHILD_SCRIPT], {
    env: {
      ...process.env,
      NARSIL_DIR: directory,
      NARSIL_KILL_AT: killAt,
      NARSIL_DOCUMENTS: String(DOCUMENTS),
      NARSIL_BODY_LENGTH: String(BODY_LENGTH),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (chunk: Buffer) => {
    stdout += chunk.toString()
  })
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString()
  })
  return new Promise<number>((resolve, reject) => {
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, CHILD_TIMEOUT_MS)
    child.on('error', reject)
    child.on('exit', (_code, signal) => {
      clearTimeout(timer)
      const lines = stdout.split('\n').filter(line => line.length > 0)
      const saved = lines.find(line => line.startsWith('SAVED '))
      if (
        timedOut ||
        signal !== 'SIGKILL' ||
        !lines.includes('READY') ||
        saved === undefined ||
        !reachedKillPoint(lines, killAt) ||
        lines.some(l => l.startsWith('DONE'))
      ) {
        reject(new Error(`The child ended without reaching ${killAt}: ${lines.slice(-3).join(' | ')} ${stderr}`))
        return
      }
      resolve(Number(saved.slice('SAVED '.length)))
    })
  })
}

function survivingDocuments(): { expected: Map<string, string>; removed: string[] } {
  const expected = new Map<string, string>()
  const removed: string[] = []
  for (let at = 0; at < DOCUMENTS; at++) {
    if (at % 2 === 0) removed.push(`n${at}`)
    else expected.set(`n${at}`, bodyOf(at, BODY_LENGTH))
  }
  return { expected, removed }
}

describe.skipIf(!BUILT)('a process killed while a checkpoint rewrites removed documents', () => {
  let directory: string
  let engine: Narsil | null = null

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'narsil-rewrite-crash-'))
  })

  afterEach(async () => {
    await engine?.shutdown()
    engine = null
    await rm(directory, { recursive: true, force: true })
  })

  it.each(
    KILL_POINTS,
  )('keeps every acknowledged removal, reports the files on disk, and finishes the rewrite after a kill at %s', async killAt => {
    const savedBeforeRemovals = await runUntilKilled(directory, killAt)
    const { expected, removed } = survivingDocuments()
    const config = {
      durability: { directory, checkpointIntervalMs: 0, checkpointMutationThreshold: 1_000_000_000 },
      workers: { enabled: false },
    }

    engine = await createNarsil(config)
    await expectDocumentsOf(engine, INDEX, expected, removed)
    await expectFiguresMatchTheFiles(engine, directory, INDEX)

    for (let round = 0; round < 3; round++) await engine.checkpoint(INDEX)
    const savedAfterRewrite = engine.getStats(INDEX).savedBytes ?? Number.POSITIVE_INFINITY
    expect(savedAfterRewrite).toBeLessThanOrEqual(savedBytesAllowedFor(expected.size, savedBeforeRemovals / DOCUMENTS))
    await expectFiguresMatchTheFiles(engine, directory, INDEX)
    await expectDocumentsOf(engine, INDEX, expected, removed)

    await engine.shutdown()
    engine = await createNarsil(config)
    expect(engine.getStats(INDEX).savedBytes).toBe(savedAfterRewrite)
    await expectFiguresMatchTheFiles(engine, directory, INDEX)
    await expectDocumentsOf(engine, INDEX, expected, removed)
  }, 120_000)
})
