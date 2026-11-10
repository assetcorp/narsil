import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { cp, mkdir, mkdtemp, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createNarsil } from '../../../narsil'
import type { AnyDocument } from '../../../types/schema'
import {
  INDEX,
  LANGUAGE_NAME,
  PROBE_TERMS,
  registerWorkshopLanguage,
  stemOf,
  workshopCorpus,
} from '../partial-words/corpus'
import { expectSameHits, NO_WORKERS, RESULT_LIMIT, WORKSHOP_INDEX_CONFIG } from '../partial-words/harness'
import { createOracle, type OracleHit, type OracleQuery } from '../partial-words/oracle'

vi.setConfig({ testTimeout: 180_000, hookTimeout: 180_000 })

const run = promisify(execFile)
const DIST = fileURLToPath(new URL('../../../../dist/', import.meta.url))
const BROWSER_ENTRY_FILE = 'index.browser.mjs'
const PARTIAL_WORDS_ENTRY_FILE = 'partial-words.browser.mjs'
const BROWSER_CHUNKS = 'browser'
const BROWSER_ENTRY = join(DIST, BROWSER_ENTRY_FILE)
const FIRST_DOCUMENTS = 400
const ADDED_DOCUMENTS = 120
const PROBE_OUTPUT_BYTES = 64 * 1024 * 1024
const SHAPES: readonly Omit<OracleQuery, 'term'>[] = [
  { partialWords: true },
  { partialWords: true, prefix: true },
  { partialWords: false },
  { partialWords: false, termMatch: 'all' },
]
const QUERIES: readonly OracleQuery[] = PROBE_TERMS.flatMap(term => SHAPES.map(shape => ({ term, ...shape })))

const PROBE = `
import { readFile, rename } from 'node:fs/promises'
import { join } from 'node:path'
const [entry, partialWordsEntry, work, heldWriteChunk] = process.argv.slice(2)
const { createNarsil, registerLanguage, registerPartialWordSearch } = await import(entry)
const { partialWordSearch } = await import(partialWordsEntry)
registerPartialWordSearch(partialWordSearch)
const input = JSON.parse(await readFile(join(work, 'input.json'), 'utf8'))
registerLanguage({ name: input.language, revision: '1', stemmer: ${stemOf.toString()}, stopWords: new Set() })
const engine = await createNarsil({ workers: { enabled: false } })
const snapshot = new Uint8Array(await readFile(join(work, 'snapshot.bin')))
const outcome = {}
if (heldWriteChunk !== undefined) {
  try {
    await engine.restore(input.index, snapshot)
    outcome.withoutWriteCode = 'restored'
  } catch {
    outcome.withoutWriteCode = 'refused'
  }
  outcome.indexesWithoutWriteCode = engine.listIndexes().map(index => index.name)
  await rename(heldWriteChunk, heldWriteChunk.slice(0, -'.held'.length))
}
await engine.restore(input.index, snapshot)
outcome.answers = []
for (const query of input.queries) {
  const result = await engine.query(input.index, { ...query, limit: input.limit })
  outcome.answers.push(result.hits.map(hit => ({ id: hit.id, score: hit.score })))
}
await engine.shutdown()
console.log(JSON.stringify(outcome))
`
const HELD_SUFFIX = '.held'
const WRITE_CHUNK = /^optional-writes-.*\.mjs$/

let work: string | null = null
let durable: string | null = null
let held: AnyDocument[] = []

interface RestoreOutcome {
  withoutWriteCode?: 'restored' | 'refused'
  indexesWithoutWriteCode?: string[]
  answers: OracleHit[][]
}

async function restoreInBrowserCopy(name: string, holdsWriteCode: boolean): Promise<RestoreOutcome> {
  if (work === null) throw new Error('The writer never prepared a work directory')
  const copy = join(work, name.replaceAll(' ', '-'))
  await mkdir(copy)
  for (const file of [BROWSER_ENTRY_FILE, PARTIAL_WORDS_ENTRY_FILE]) await cp(join(DIST, file), join(copy, file))
  await cp(join(DIST, BROWSER_CHUNKS), join(copy, BROWSER_CHUNKS), { recursive: true })
  const args = [
    join(work, 'probe.mjs'),
    pathToFileURL(join(copy, BROWSER_ENTRY_FILE)).href,
    pathToFileURL(join(copy, PARTIAL_WORDS_ENTRY_FILE)).href,
    work,
  ]
  if (holdsWriteCode) {
    const chunks = (await readdir(join(copy, BROWSER_CHUNKS))).filter(file => WRITE_CHUNK.test(file))
    expect(chunks).toHaveLength(1)
    const chunk = join(copy, BROWSER_CHUNKS, chunks[0])
    await rename(chunk, `${chunk}${HELD_SUFFIX}`)
    args.push(`${chunk}${HELD_SUFFIX}`)
  }
  const { stdout } = await run(process.execPath, args, { maxBuffer: PROBE_OUTPUT_BYTES })
  const lines = stdout.trim().split('\n')
  return JSON.parse(lines[lines.length - 1]) as RestoreOutcome
}

function expectOracleAnswers(answers: OracleHit[][], label: string): void {
  const oracle = createOracle(held)
  expect(answers).toHaveLength(QUERIES.length)
  QUERIES.forEach((query, at) => {
    expectSameHits(answers[at], oracle.search(query), `${label} ${JSON.stringify(query)}`)
  })
}

async function filesUnder(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { recursive: true, withFileTypes: true })
  return entries.filter(entry => entry.isFile()).map(entry => join(entry.parentPath, entry.name))
}

async function writeSnapshotWithTombstoneSegment(directory: string): Promise<Uint8Array> {
  const first = workshopCorpus(FIRST_DOCUMENTS, 71)
  const removed = first.filter((_, at) => at % 3 === 0).map(document => String(document.id))
  const gone = new Set(removed)
  const replacements = workshopCorpus(FIRST_DOCUMENTS, 73)
  const updated = first
    .map((document, at) => ({ ...replacements[at], id: document.id }))
    .filter((document, at) => at % 7 === 1 && !gone.has(String(document.id)))
  const added = workshopCorpus(ADDED_DOCUMENTS, 79, 'added')
  const changed = new Map(updated.map(document => [String(document.id), document]))
  held = [
    ...first
      .filter(document => !gone.has(String(document.id)))
      .map(document => changed.get(String(document.id)) ?? document),
    ...added,
  ]
  const writer = await createNarsil({ durability: { directory }, workers: NO_WORKERS })
  try {
    await writer.createIndex(INDEX, WORKSHOP_INDEX_CONFIG)
    expect((await writer.insertBatch(INDEX, first)).failed).toEqual([])
    await writer.checkpoint(INDEX)
    expect((await writer.removeBatch(INDEX, removed)).failed).toEqual([])
    for (const document of updated) await writer.update(INDEX, String(document.id), document)
    expect((await writer.insertBatch(INDEX, added)).failed).toEqual([])
    await writer.checkpoint(INDEX)
    return new Uint8Array(await new Response(await writer.snapshot(INDEX)).arrayBuffer())
  } finally {
    await writer.shutdown()
  }
}

describe.skipIf(!existsSync(BROWSER_ENTRY))(
  'a browser engine whose first removal comes from a restored snapshot',
  () => {
    beforeAll(async () => {
      registerWorkshopLanguage()
      work = await mkdtemp(join(DIST, 'frozen-first-removal-'))
      durable = await mkdtemp(join(tmpdir(), 'narsil-frozen-first-removal-'))
      await writeFile(join(work, 'snapshot.bin'), await writeSnapshotWithTombstoneSegment(durable))
      await writeFile(
        join(work, 'input.json'),
        JSON.stringify({ index: INDEX, language: LANGUAGE_NAME, limit: RESULT_LIMIT, queries: QUERIES }),
      )
      await writeFile(join(work, 'probe.mjs'), PROBE)
    })

    afterAll(async () => {
      for (const directory of [work, durable])
        if (directory !== null) await rm(directory, { recursive: true, force: true })
      work = null
      durable = null
    })

    it('writes the removals and updates of the second checkpoint into a later segment of the same partition', async () => {
      const segments = (await filesUnder(durable ?? '')).filter(path => path.includes(join(INDEX, 'segments', '0')))
      expect(segments.length).toBeGreaterThanOrEqual(2)
    })

    it('restores the snapshot and answers every query like the oracle without an earlier write', async () => {
      const outcome = await restoreInBrowserCopy('whole build', false)
      expectOracleAnswers(outcome.answers, 'restored')
    })

    it('refuses the restore without the write code, holds no index, and restores once the file returns', async () => {
      const outcome = await restoreInBrowserCopy('held write code', true)
      expect(outcome.withoutWriteCode).toBe('refused')
      expect(outcome.indexesWithoutWriteCode).toEqual([])
      expectOracleAnswers(outcome.answers, 'restored once the write code returned')
    })
  },
)
