import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, open, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createNarsil } from '../../../narsil'
import type { Narsil } from '../../../types/engine'

const INDEX = 'ledgers'
const ENTRIES = 200
const STAGED_META_PREFIX = 'meta.tmp-'
const STAGED_META_POLL_MS = 1
const STAGED_META_DEADLINE_MS = 60_000
const READER_HOLDS_AFTER_STAGING_MS = 1_000
const BEYOND_EVERY_MUTATION = 1_000_000_000
const TEST_TIMEOUT_MS = 120_000
const WINDOWS_READER_SCRIPT = [
  "$held = [System.IO.File]::Open($env:NARSIL_HELD_FILE, 'Open', 'Read', 'ReadWrite')",
  "[Console]::Out.WriteLine('held')",
  '[Console]::Out.Flush()',
  '[void][Console]::In.ReadLine()',
  '$held.Close()',
].join('; ')

interface OutsideReader {
  close(): Promise<void>
}

function ledgerTitle(entry: number): string {
  return `ledger entry ${entry}`
}

async function openEngine(directory: string): Promise<Narsil> {
  return createNarsil({
    durability: { directory, mode: 'sync', checkpointMutationThreshold: BEYOND_EVERY_MUTATION },
    workers: { enabled: false },
  })
}

async function holdOpenInAnotherProgram(path: string): Promise<OutsideReader> {
  const reader = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', WINDOWS_READER_SCRIPT], {
    env: { ...process.env, NARSIL_HELD_FILE: path },
    stdio: ['pipe', 'pipe', 'inherit'],
  })
  const exited = once(reader, 'exit')
  let printed = ''
  await new Promise<void>((resolve, reject) => {
    reader.once('error', reject)
    reader.once('exit', code =>
      reject(new Error(`the outside reader exited with code ${code} before it held the file`)),
    )
    reader.stdout.on('data', (chunk: Buffer) => {
      printed += chunk.toString('utf8')
      if (printed.includes('held')) resolve()
    })
  })
  return {
    async close() {
      reader.stdin.end()
      const [code] = await exited
      if (code !== 0) throw new Error(`the outside reader exited with code ${code} as it closed the file`)
    },
  }
}

async function holdOpen(path: string): Promise<OutsideReader> {
  if (process.platform === 'win32') return holdOpenInAnotherProgram(path)
  const handle = await open(path, 'r')
  return { close: () => handle.close() }
}

async function stagedMetaWaiting(indexDirectory: string): Promise<boolean> {
  const names = await readdir(indexDirectory).catch(() => [])
  return names.some(name => name.startsWith(STAGED_META_PREFIX))
}

function pause(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

describe('a checkpoint beside an outside reader of the meta file', () => {
  let directory: string

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'narsil-held-reader-'))
  })

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true })
  })

  it(
    'saves once the reader closes the meta file it held open, and every entry comes back after a restart',
    async () => {
      const engine = await openEngine(directory)
      await engine.createIndex(INDEX, { schema: { title: 'string' } })
      const entries = Array.from({ length: ENTRIES }, (_, entry) => ({
        id: `entry-${entry}`,
        title: ledgerTitle(entry),
      }))
      const inserted = await engine.insertBatch(INDEX, entries)
      expect(inserted.failed).toEqual([])

      const indexDirectory = join(directory, INDEX)
      const metaPath = join(indexDirectory, 'meta')
      const before = await readFile(metaPath)
      const reader = await holdOpen(metaPath)

      let settled = false
      const saved = engine.checkpoint(INDEX).then(
        () => null,
        (error: unknown) => error,
      )
      void saved.then(() => {
        settled = true
      })
      const deadline = performance.now() + STAGED_META_DEADLINE_MS
      let stagedAt: number | null = null
      while (!settled && performance.now() < deadline) {
        if (stagedAt !== null && performance.now() - stagedAt >= READER_HOLDS_AFTER_STAGING_MS) break
        if (stagedAt === null && (await stagedMetaWaiting(indexDirectory))) stagedAt = performance.now()
        await pause(STAGED_META_POLL_MS)
      }
      const finishedWhileHeld = settled
      await reader.close()

      if (process.platform === 'win32') {
        expect(
          finishedWhileHeld,
          `the checkpoint finished while an outside reader held the meta file, with ${String(await saved)}`,
        ).toBe(false)
      }
      expect(await saved).toBeNull()
      expect((await readFile(metaPath)).equals(before)).toBe(false)
      await engine.shutdown()

      const reopened = await openEngine(directory)
      try {
        for (let entry = 0; entry < ENTRIES; entry++) {
          expect(await reopened.get(INDEX, `entry-${entry}`)).toMatchObject({ title: ledgerTitle(entry) })
        }
      } finally {
        await reopened.shutdown()
      }
    },
    TEST_TIMEOUT_MS,
  )
})
