import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import type { Narsil } from '../../../narsil'
import {
  archiveBytes,
  configFor,
  fill,
  type Generation,
  holdsGeneration,
  LIVE,
  NEW,
  NEW_COUNT,
  newDirectory,
  OLD,
  OLD_COUNT,
  openEngine,
  SOURCE,
} from './restore-fixtures'

const CHILD_SCRIPT = fileURLToPath(new URL('./restore-child-dist.mjs', import.meta.url))
const built = await readdir(new URL('../../../../dist/', import.meta.url)).then(
  entries => entries.includes('index.mjs'),
  () => false,
)

type DurableKind = 'wal' | 'snapshot'

const roots: string[] = []
const engines: Narsil[] = []

afterEach(async () => {
  for (const engine of engines.splice(0)) await engine.shutdown().catch(() => undefined)
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function preparedDirectory(kind: DurableKind): Promise<{ directory: string; archive: string }> {
  const directory = await newDirectory(roots)
  const scratch = await newDirectory(roots)
  const engine = await openEngine(configFor(kind, directory, false), engines)
  await fill(engine, LIVE, OLD.documents)
  await fill(engine, SOURCE, NEW.documents)
  const archive = join(scratch, 'archive.tar')
  await writeFile(archive, await archiveBytes(engine, SOURCE))
  await engine.dropIndex(SOURCE)
  await engine.checkpoint(LIVE)
  await engine.shutdown()
  return { directory, archive }
}

function runChild(kind: DurableKind, directory: string, archive: string, killAt: string) {
  const child = spawn(process.execPath, [CHILD_SCRIPT], {
    env: { ...process.env, NARSIL_DIR: directory, NARSIL_TIER: kind, NARSIL_KILL_AT: killAt, NARSIL_ARCHIVE: archive },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  child.stdout.on('data', (chunk: Buffer) => {
    output += chunk.toString()
  })
  child.stderr.on('data', (chunk: Buffer) => {
    output += chunk.toString()
  })
  return new Promise<{ signal: NodeJS.Signals | null; output: string }>(resolve => {
    child.on('exit', (_code, signal) => resolve({ signal, output }))
  })
}

async function leftoverFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { recursive: true, withFileTypes: true })
  return entries
    .filter(entry => entry.isFile() && entry.name !== '.narsil.lock')
    .map(entry => `${entry.parentPath}/${entry.name}`.slice(directory.length + 1))
    .filter(path => path.startsWith('.'))
}

async function expectWhole(kind: DurableKind, directory: string, expected: Generation, count: number) {
  const engine = await openEngine(configFor(kind, directory, false), engines)
  expect(await holdsGeneration(engine, LIVE, expected)).toBe(true)
  expect(await engine.countDocuments(LIVE)).toBe(count)
  expect(await leftoverFiles(directory)).toEqual([])
}

const KILL_POINTS: Array<{ kind: DurableKind; killAt: string; expected: Generation; count: number }> = [
  { kind: 'wal', killAt: 'stage', expected: OLD, count: OLD_COUNT },
  { kind: 'wal', killAt: 'journal', expected: OLD, count: OLD_COUNT },
  { kind: 'wal', killAt: 'retire', expected: NEW, count: NEW_COUNT },
  { kind: 'wal', killAt: 'install', expected: NEW, count: NEW_COUNT },
  { kind: 'wal', killAt: 'unjournal', expected: NEW, count: NEW_COUNT },
  { kind: 'snapshot', killAt: 'stage', expected: OLD, count: OLD_COUNT },
  { kind: 'snapshot', killAt: 'journal', expected: OLD, count: OLD_COUNT },
  { kind: 'snapshot', killAt: 'move', expected: NEW, count: NEW_COUNT },
  { kind: 'snapshot', killAt: 'unjournal', expected: NEW, count: NEW_COUNT },
]

describe.skipIf(!built)('a restore that the process dies during', () => {
  for (const { kind, killAt, expected, count } of KILL_POINTS) {
    const generation = expected === OLD ? 'old' : 'restored'
    it(`reopens the ${generation} index whole after a kill at "${killAt}", on an engine in ${kind}`, async () => {
      const { directory, archive } = await preparedDirectory(kind)

      const { signal, output } = await runChild(kind, directory, archive, killAt)

      expect(signal, output).toBe('SIGKILL')
      await expectWhole(kind, directory, expected, count)
    }, 30_000)
  }
})

function digestOf(indexName: string): string {
  return createHash('sha256').update(indexName, 'utf8').digest('hex')
}

const LEFTOVER_JOURNALS: Array<{ kind: DurableKind; what: string; key: string; content: string }> = [
  {
    kind: 'wal',
    what: 'a temporary journal',
    key: `.swap-${digestOf(LIVE)}.tmp-1-2-abc`,
    content: `${LIVE}\n.restore-x/`,
  },
  { kind: 'snapshot', what: 'a journal cut off partway', key: `.swap-${digestOf(LIVE)}`, content: LIVE.slice(0, 2) },
]

const HOSTILE_JOURNALS: Array<{ what: string; name: string; prefix: string }> = [
  { what: 'a parent directory', name: LIVE, prefix: '../' },
  { what: 'the lock file', name: LIVE, prefix: '.narsil.lock/' },
  { what: 'an index name that no index can hold', name: '../escape', prefix: '.restore-x/' },
]

describe('a restore journal that a crash or a hostile user left behind', () => {
  for (const { kind, what, key, content } of LEFTOVER_JOURNALS) {
    it(`deletes ${what} and keeps the old index serving, on an engine in ${kind}`, async () => {
      const { directory } = await preparedDirectory(kind)
      await writeFile(join(directory, key), content)
      await mkdir(join(directory, '.restore-orphan'))
      await writeFile(join(directory, '.restore-orphan', 'manifest'), 'stray')
      await expectWhole(kind, directory, OLD, OLD_COUNT)
    }, 30_000)
  }

  for (const { what, name, prefix } of HOSTILE_JOURNALS) {
    it(`refuses to start on a journal that names ${what}, moving nothing`, async () => {
      const { directory } = await preparedDirectory('wal')
      await writeFile(join(directory, `.swap-${digestOf(name)}`), `${name}\n${prefix}`)

      await expect(openEngine(configFor('wal', directory, false), engines)).rejects.toMatchObject({
        code: 'PERSISTENCE_LOAD_FAILED',
      })
      await rm(join(directory, `.swap-${digestOf(name)}`))
      await expectWhole('wal', directory, OLD, OLD_COUNT)
    }, 30_000)
  }
})
