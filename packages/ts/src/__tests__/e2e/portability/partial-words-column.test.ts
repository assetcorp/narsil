import { afterEach, describe, expect, it } from 'vitest'
import { ErrorCodes, NarsilError } from '../../../errors'
import type { Narsil } from '../../../narsil'
import type { AnyDocument, IndexConfig } from '../../../types/schema'
import { bytesOf, readTar, rewriteFiles, type TarEntry, uint32Bytes, uint32Values, writeTar } from './archive-oracle'
import { catalogOf, documentsOf, ENGINE_KINDS, insertCatalog, storedForm, temporaryRoots } from './harness'

const PARTIAL_CONFIG: IndexConfig = {
  schema: { title: 'string', body: 'string:partial', price: 'number' },
  language: 'english',
}
const PROBE = 'arbou'

const roots = temporaryRoots()
const engines: Narsil[] = []

afterEach(async () => {
  for (const engine of engines.splice(0)) await engine.shutdown()
  await roots.removeAll()
})

type Column = Record<string, unknown>

function partialCatalog(): Map<string, AnyDocument> {
  const documents = new Map<string, AnyDocument>()
  for (const [id, document] of catalogOf(120)) {
    documents.set(id, { title: document.title, body: `${document.body} standing`, price: document.price })
  }
  return documents
}

function idsHoldingTheProbe(documents: Map<string, AnyDocument>): string[] {
  const ids: string[] = []
  for (const [id, document] of documents) {
    const words = String(document.body).toLowerCase().split(' ')
    if (words.some(word => word.length > PROBE.length && word.includes(PROBE))) ids.push(id)
  }
  return ids.sort()
}

async function idsMatchingTheProbe(engine: Narsil): Promise<string[]> {
  const result = await engine.query('partial', {
    term: PROBE,
    fields: ['body'],
    partialWords: true,
    tolerance: 0,
    prefix: false,
    limit: 200,
  })
  return result.hits.map(hit => hit.id).sort()
}

function withColumn(entries: readonly TarEntry[], change: (column: Column) => Column | null): Uint8Array {
  let changed = 0
  const rewritten = rewriteFiles(entries, payload => {
    const column = payload.partialWords
    if (column === null || typeof column !== 'object') return false
    payload.partialWords = change({ ...(column as Column) })
    changed++
    return true
  })
  if (changed === 0) throw new Error('the archive holds no segment with a partialWords column')
  return writeTar(rewritten)
}

function uint32s(column: Column, key: string): number[] {
  return uint32Values(column[key] as Uint8Array)
}

function withUint32s(column: Column, key: string, change: (values: number[]) => void): Column {
  const values = uint32s(column, key)
  change(values)
  return { ...column, [key]: uint32Bytes(values) }
}

function swappedFirstTwoSpellings(column: Column): Column {
  const text = column.text as Uint8Array
  const [start, middle, end] = uint32s(column, 'offsets')
  const first = text.slice(start, middle)
  const second = text.slice(middle, end)
  const swapped = text.slice()
  swapped.set(second, start)
  swapped.set(first, start + second.byteLength)
  return withUint32s({ ...column, text: swapped }, 'offsets', offsets => {
    offsets[1] = start + second.byteLength
  })
}

function reversedRuns(column: Column): Column {
  const points = uint32s(column, 'runs')
  const runs: number[][] = []
  for (let at = 0; at < points.length; at += 3) runs.push(points.slice(at, at + 3))
  return { ...column, runs: uint32Bytes(runs.reverse().flat()) }
}

function swappedMembersOfOneRun(column: Column): Column {
  const offsets = uint32s(column, 'runOffsets')
  const run = offsets.findIndex((offset, at) => at + 1 < offsets.length && offsets[at + 1] - offset >= 2)
  if (run < 0) throw new Error('no run holds two entries')
  return withUint32s(column, 'runEntries', members => {
    const at = offsets[run]
    ;[members[at], members[at + 1]] = [members[at + 1], members[at]]
  })
}

async function refusalOf(engine: Narsil, data: Uint8Array): Promise<NarsilError> {
  try {
    await engine.restore('partial', data)
  } catch (error) {
    if (error instanceof NarsilError) return error
    throw error
  }
  throw new Error('the engine restored a hostile partialWords column')
}

describe.each(ENGINE_KINDS)('the partialWords column in a snapshot archive of $name', kind => {
  async function sourceWithCatalog() {
    const opened = await kind.open(roots)
    engines.push(opened.engine)
    await opened.engine.createIndex('partial', PARTIAL_CONFIG)
    const documents = partialCatalog()
    await insertCatalog(opened.engine, 'partial', documents)
    const entries = readTar(await bytesOf(await opened.engine.snapshot('partial')))
    return { engine: opened.engine, documents, entries }
  }

  it('refuses every column that breaks the format and leaves the index it would replace whole', async () => {
    const { engine, documents, entries } = await sourceWithCatalog()
    const expected = idsHoldingTheProbe(documents)
    expect(expected.length).toBeGreaterThan(0)
    expect(await idsMatchingTheProbe(engine)).toEqual(expected)

    const hostile: Array<[string, (column: Column) => Column]> = [
      ['a token at or above the token count', column => withUint32s(column, 'tokens', tokens => (tokens[0] = 2 ** 31))],
      ['a count of 0', column => withUint32s(column, 'counts', counts => (counts[0] = 0))],
      [
        'a run member at or above the entry count',
        column => withUint32s(column, 'runEntries', members => (members[0] = uint32s(column, 'tokens').length)),
      ],
      ['entries out of spelling order', swappedFirstTwoSpellings],
      ['runs out of order', reversedRuns],
      ['the members of a run out of order', swappedMembersOfOneRun],
      [
        'an offset past the end of the text',
        column => withUint32s(column, 'offsets', offsets => offsets.fill(2 ** 30, -1)),
      ],
      [
        'a text that is no UTF-8',
        column => ({ ...column, text: new Uint8Array((column.text as Uint8Array).length).fill(0xff) }),
      ],
    ]

    for (const [what, change] of hostile) {
      const refusal = await refusalOf(engine, withColumn(entries, change))
      expect(refusal.code, `${what}: ${refusal.message}`).toBe(ErrorCodes.PERSISTENCE_LOAD_FAILED)
      expect(await documentsOf(engine, 'partial', documents.keys()), what).toEqual(storedForm(documents))
    }
    expect(await idsMatchingTheProbe(engine)).toEqual(expected)
  })

  it('matches inside words after a restore that derives the spellings from the documents', async () => {
    const { documents, entries } = await sourceWithCatalog()
    const expected = idsHoldingTheProbe(documents)

    for (const archive of [
      withColumn(entries, () => null),
      withColumn(entries, column => ({ ...column, fields: ['title'] })),
    ]) {
      const target = (await kind.open(roots)).engine
      engines.push(target)
      await target.restore('partial', archive)
      expect(await idsMatchingTheProbe(target)).toEqual(expected)
    }
  })
})
