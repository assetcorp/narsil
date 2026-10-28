import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { registerTokenizer } from '../../../analysis/registry'
import { createNarsil, type Narsil } from '../../../narsil'
import type { AnyDocument } from '../../../types/schema'
import { INDEX, PROBE_TERMS, registerWorkshopLanguage, stemOf, workshopCorpus } from '../partial-words/corpus'
import {
  expectSameHits,
  hitsOf,
  NO_WORKERS,
  RESULT_LIMIT,
  type SearchFn,
  WORKSHOP_INDEX_CONFIG,
} from '../partial-words/harness'
import { createOracle, type OracleQuery } from '../partial-words/oracle'

const SWITCHING_TOKENIZER = 'frozen-removal-switching'
const MARKER = 'zyxzyq'
const MARKER_PLURAL = `${MARKER}s`
const DOCUMENTS = 1_600
const SHAPES: readonly Omit<OracleQuery, 'term'>[] = [
  { partialWords: false },
  { partialWords: false, termMatch: 'all' },
  { partialWords: false, fields: ['body'] },
  { partialWords: false, boost: { title: 2.5, body: 0.5 } },
]

let keepsMarkerPlural = false
let directory: string | null = null
let engine: Narsil | null = null

function tokenOf(word: string): string {
  return keepsMarkerPlural && word === MARKER_PLURAL ? word : stemOf(word)
}

beforeAll(() => {
  registerWorkshopLanguage()
  registerTokenizer(SWITCHING_TOKENIZER, {
    tokenize: text =>
      text
        .split(' ')
        .filter(word => word.length > 0)
        .map((word, position) => ({ token: tokenOf(word), position })),
  })
})

afterEach(async () => {
  keepsMarkerPlural = false
  await engine?.shutdown()
  engine = null
  if (directory !== null) await rm(directory, { recursive: true, force: true })
  directory = null
})

function markedCorpus(): AnyDocument[] {
  return workshopCorpus(DOCUMENTS, 41).map((document, at) => {
    if (at % 4 === 1) return { ...document, body: `${String(document.body)} ${MARKER_PLURAL} ${MARKER_PLURAL}` }
    if (at % 4 === 2) return { ...document, body: `${String(document.body)} ${MARKER}` }
    return document
  })
}

function searchOf(narsil: Narsil): SearchFn {
  return async query => hitsOf(await narsil.query(INDEX, { ...query, limit: RESULT_LIMIT }))
}

async function expectOracle(narsil: Narsil, documents: readonly AnyDocument[], label: string): Promise<void> {
  const oracle = createOracle(documents)
  const search = searchOf(narsil)
  for (const term of [...PROBE_TERMS, MARKER, `${MARKER} water`]) {
    for (const shape of SHAPES) {
      const query = { term, ...shape }
      expectSameHits(await search(query), oracle.search(query), `${label} ${JSON.stringify(query)}`)
    }
  }
}

async function openFrozen(): Promise<Narsil> {
  if (directory === null) throw new Error('the test opened no directory')
  engine = await createNarsil({ durability: { directory }, workers: NO_WORKERS })
  return engine
}

async function removeFrom(narsil: Narsil, held: Map<string, AnyDocument>, leaving: readonly AnyDocument[]) {
  const docIds = leaving.map(document => String(document.id))
  expect((await narsil.removeBatch(INDEX, docIds)).failed).toEqual([])
  for (const docId of docIds) held.delete(docId)
}

describe('removals from frozen segments keep every score equal to the independent oracle', () => {
  it.each([
    ['the tokeniser stays as the segment froze it', false],
    ['the tokeniser splits a removed spelling differently after the segment freezes', true],
  ] as const)(
    'when %s',
    async (_change, switchesTokenizer) => {
      directory = await mkdtemp(join(tmpdir(), 'narsil-frozen-removals-'))
      const documents = markedCorpus()
      const writer = await createNarsil({ durability: { directory }, workers: NO_WORKERS })
      await writer.createIndex(INDEX, { ...WORKSHOP_INDEX_CONFIG, tokenizer: SWITCHING_TOKENIZER })
      expect((await writer.insertBatch(INDEX, documents)).failed).toEqual([])
      await writer.checkpoint(INDEX)
      await writer.shutdown()

      const held = new Map(documents.map(document => [String(document.id), document]))
      const frozen = await openFrozen()
      await expectOracle(frozen, [...held.values()], 'loaded')

      await removeFrom(
        frozen,
        held,
        documents.filter((_, at) => at % 4 === 3 && at % 3 === 0),
      )
      await expectOracle(frozen, [...held.values()], 'before the change')

      keepsMarkerPlural = switchesTokenizer
      await removeFrom(
        frozen,
        held,
        documents.filter((_, at) => at % 4 === 1 && at % 5 !== 0),
      )
      await expectOracle(frozen, [...held.values()], 'removed the marked documents')

      await removeFrom(
        frozen,
        held,
        documents.filter((_, at) => (at % 4 === 0 || at % 4 === 2) && at % 7 === 0),
      )
      await expectOracle(frozen, [...held.values()], 'removed more after the marked documents')

      await frozen.shutdown()
      engine = null
      const reopened = await openFrozen()
      await expectOracle(reopened, [...held.values()], 'reopened')
      await removeFrom(
        reopened,
        held,
        documents.filter((_, at) => at % 4 === 1 && at % 5 === 0),
      )
      await expectOracle(reopened, [...held.values()], 'removed the last marked documents after reopening')
      expect(await reopened.countDocuments(INDEX)).toBe(held.size)
    },
    120_000,
  )
})
