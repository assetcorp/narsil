import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ErrorCodes, NarsilError } from '../../errors'
import { createNarsil, type Narsil } from '../../narsil'
import { querySuggestions } from '../../query-suggestions'
import {
  DASHES_TOKENIZER,
  PLAIN_LANGUAGE,
  registerFixtures,
  seededRandom,
  sentence,
} from '../engine/analysis-change/oracle'

const KEY_TEXT = 'a popular query key that is long enough for the engine'
const SOURCE = 'prose'
const GROUP = 'readers'
const DOCUMENTS = 2_000
const SEARCHED_PHRASE = 'river stone'
const DASHED_TITLE = 'quartz-lantern'
const DASHED_PART = 'quartz'
const DAMAGED_ARCHIVE = new TextEncoder().encode('these bytes hold no snapshot archive')

interface HeldArchive {
  source: AsyncIterable<Uint8Array>
  release(): void
  readStarted: Promise<void>
}

function heldArchive(bytes: Uint8Array): HeldArchive {
  let release: () => void = () => undefined
  const released = new Promise<void>(resolve => {
    release = resolve
  })
  let markReadStarted: () => void = () => undefined
  const readStarted = new Promise<void>(resolve => {
    markReadStarted = resolve
  })
  async function* chunks(): AsyncGenerator<Uint8Array> {
    markReadStarted()
    await released
    yield bytes
  }
  return { source: chunks(), release, readStarted }
}

function codeOf(error: unknown): string {
  return error instanceof NarsilError ? error.code : String(error)
}

const engines: Narsil[] = []
const directories: string[] = []

afterEach(async () => {
  for (const engine of engines.splice(0)) await engine.shutdown()
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true })
})

function engineConfig(directory: string | null) {
  return {
    querySuggestions: { key: KEY_TEXT },
    workers: { enabled: false },
    ...(directory === null ? {} : { durability: { directory } }),
  }
}

async function engineWithHistory(directory: string | null = null): Promise<{ engine: Narsil; archive: Uint8Array }> {
  registerFixtures()
  const engine = await createNarsil(engineConfig(directory))
  engines.push(engine)
  const random = seededRandom(100)
  const documents = Array.from({ length: DOCUMENTS }, (_, at) => ({ id: `doc-${at}`, title: sentence(random) }))
  documents.push({ id: 'doc-searched', title: SEARCHED_PHRASE }, { id: 'doc-dashed', title: DASHED_TITLE })
  await engine.createIndex(SOURCE, {
    schema: { title: 'string' },
    language: PLAIN_LANGUAGE,
    partitions: { maxPartitions: 3 },
  })
  await engine.insertBatch(SOURCE, documents)
  const suggestions = querySuggestions(engine)
  await suggestions.updateSetting(SOURCE, { enabled: true, fields: ['title'], minPeople: 2, minResults: 1 })
  for (const person of ['person-1', 'person-2']) {
    await suggestions.recordQuery(SOURCE, { query: SEARCHED_PHRASE, person, group: GROUP })
  }
  const archive = new Uint8Array(
    await new Response(await engine.snapshot(SOURCE, { queryHistory: true })).arrayBuffer(),
  )
  return { engine, archive }
}

async function expectArchiveServed(engine: Narsil): Promise<void> {
  expect(await engine.countDocuments(SOURCE)).toBe(DOCUMENTS + 2)
  const wholeWord = await engine.query(SOURCE, { term: DASHED_PART })
  expect(wholeWord.hits.map(hit => hit.id)).toEqual([])
  expect((await querySuggestions(engine).preview(SOURCE)).entries).toEqual([
    { group: GROUP, query: SEARCHED_PHRASE, count: 2 },
  ])
}

describe('an analysis change while a restore of an archive with query history is in flight', () => {
  it('refuses a change that a caller asks for while the restore reads its archive', async () => {
    const { engine, archive } = await engineWithHistory()
    const held = heldArchive(archive)
    const restoring = engine.restore(SOURCE, held.source)
    await held.readStarted

    const change = engine.changeAnalysis(SOURCE, { tokenizer: DASHES_TOKENIZER }).catch(codeOf)
    expect(await change).toBe(ErrorCodes.ANALYSIS_CHANGE_REPLACED)

    held.release()
    await restoring
    await expectArchiveServed(engine)
    await engine.changeAnalysis(SOURCE, { tokenizer: DASHES_TOKENIZER })
    expect((await engine.query(SOURCE, { term: DASHED_PART })).hits.map(hit => hit.id)).toEqual(['doc-dashed'])
  }, 60_000)

  it('refuses a running change that reaches its switch while the restore reads its archive', async () => {
    const { engine, archive } = await engineWithHistory()
    const held = heldArchive(archive)
    let restoring: Promise<void> | null = null
    engine.on('analysisRebuild', event => {
      if (event.indexName === SOURCE && event.status === 'started' && restoring === null) {
        restoring = engine.restore(SOURCE, held.source)
      }
    })

    const change = await engine.changeAnalysis(SOURCE, { tokenizer: DASHES_TOKENIZER }).catch(codeOf)
    expect(change).toBe(ErrorCodes.ANALYSIS_CHANGE_REPLACED)

    held.release()
    expect(restoring).not.toBeNull()
    await restoring
    await expectArchiveServed(engine)
  }, 60_000)

  it('leaves no pending change to resume after a restart when the restore that refused it fails', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'narsil-refused-change-'))
    directories.push(directory)
    const { engine } = await engineWithHistory(directory)
    const held = heldArchive(DAMAGED_ARCHIVE)
    let restoring: Promise<string> | null = null
    engine.on('analysisRebuild', event => {
      if (event.indexName === SOURCE && event.status === 'started' && restoring === null) {
        restoring = engine.restore(SOURCE, held.source).then(() => 'restored', codeOf)
      }
    })

    expect(await engine.changeAnalysis(SOURCE, { tokenizer: DASHES_TOKENIZER }).catch(codeOf)).toBe(
      ErrorCodes.ANALYSIS_CHANGE_REPLACED,
    )
    held.release()
    expect(await restoring).not.toBe('restored')
    engines.splice(engines.indexOf(engine), 1)
    await engine.shutdown()

    const reopened = await createNarsil(engineConfig(directory))
    engines.push(reopened)
    await reopened.rebuildAnalysis(SOURCE)
    expect(await reopened.countDocuments(SOURCE)).toBe(DOCUMENTS + 2)
    expect((await reopened.query(SOURCE, { term: DASHED_PART })).hits.map(hit => hit.id)).toEqual([])
  }, 60_000)
})
