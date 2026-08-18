import { describe, expect, it } from 'vitest'
import { createInvertedIndex, type InvertedIndex } from '../../../core/inverted-index'
import { blockBoundsFor, type PostingBlockBounds } from '../../../core/partition/block-bounds'
import type { CompactPostingList, FieldNameTable } from '../../../types/internal'

const TERM = 'term'

function newIndex(): InvertedIndex {
  const fieldNameTable: FieldNameTable = {
    names: ['title', 'body'],
    indexMap: new Map([
      ['title', 0],
      ['body', 1],
    ]),
  }
  return createInvertedIndex(fieldNameTable)
}

function insertDocument(index: InvertedIndex, internalId: number, termFrequency: number): void {
  index.insert(TERM, internalId, termFrequency, 0, null)
  if (internalId % 2 === 0) index.insert(TERM, internalId, 1, 1, null)
}

function columnsFor(documentCount: number): Array<Uint32Array | null> {
  const title = new Uint32Array(documentCount)
  const body = new Uint32Array(documentCount)
  for (let internalId = 0; internalId < documentCount; internalId++) {
    title[internalId] = (internalId % 50) + 1
    body[internalId] = (internalId % 30) + 5
  }
  return [title, body]
}

function listFor(index: InvertedIndex): CompactPostingList {
  const list = index.lookup(TERM)
  if (list === undefined) throw new Error('posting list missing')
  return list
}

function recount(list: CompactPostingList, columns: Array<Uint32Array | null>, start: number, end: number) {
  let maxTf = 0
  let minLen = Number.POSITIVE_INFINITY
  let maxRun = 0
  let docs = 0
  let entry = start
  while (entry < end) {
    const docId = list.docIds[entry]
    const dead = list.deletedDocs.has(docId)
    let run = 0
    while (entry + run < end && list.docIds[entry + run] === docId) {
      if (!dead) {
        const termFrequency = list.termFrequencies[entry + run]
        if (termFrequency > maxTf) maxTf = termFrequency
        const column = columns[list.fieldNameIndices[entry + run]]
        const stored = column !== null && docId < column.length ? column[docId] : 0
        const length = stored > 0 ? stored : 0
        if (length < minLen) minLen = length
      }
      run++
    }
    if (!dead) {
      if (run > maxRun) maxRun = run
      docs++
    }
    entry += run
  }
  return { maxTf, minLen: minLen === Number.POSITIVE_INFINITY ? 0 : minLen, maxRun, docs }
}

function expectBoundsMatchRecount(
  list: CompactPostingList,
  columns: Array<Uint32Array | null>,
  bounds: PostingBlockBounds,
): void {
  expect(bounds.blockCount).toBeGreaterThan(0)
  expect(bounds.entryEnd[bounds.blockCount - 1]).toBe(list.length)
  for (let block = 0; block < bounds.blockCount; block++) {
    const start = block === 0 ? 0 : bounds.entryEnd[block - 1]
    const reference = recount(list, columns, start, bounds.entryEnd[block])
    expect(bounds.maxTermFrequency[block]).toBe(reference.maxTf)
    expect(bounds.minFieldLength[block]).toBe(reference.minLen)
    expect(bounds.maxEntriesPerDocument[block]).toBe(reference.maxRun)
    expect(bounds.documentCount[block]).toBe(reference.docs)
  }
}

function liveDocumentTotal(bounds: PostingBlockBounds): number {
  let total = 0
  for (let block = 0; block < bounds.blockCount; block++) total += bounds.documentCount[block]
  return total
}

describe('posting block bounds', () => {
  it('summarises every block to match a direct recount', () => {
    const index = newIndex()
    for (let internalId = 0; internalId < 1000; internalId++) insertDocument(index, internalId, (internalId % 9) + 1)
    const columns = columnsFor(1400)
    const list = listFor(index)
    const bounds = blockBoundsFor(list, columns)
    expectBoundsMatchRecount(list, columns, bounds)
    expect(liveDocumentTotal(bounds)).toBe(1000)
  })

  it('returns the same summaries while the list is unchanged', () => {
    const index = newIndex()
    for (let internalId = 0; internalId < 300; internalId++) insertDocument(index, internalId, 1)
    const columns = columnsFor(300)
    const list = listFor(index)
    expect(blockBoundsFor(list, columns)).toBe(blockBoundsFor(list, columns))
  })

  it('extends over appended entries and matches a build from scratch', () => {
    const index = newIndex()
    for (let internalId = 0; internalId < 1000; internalId++) insertDocument(index, internalId, (internalId % 9) + 1)
    const columns = columnsFor(1400)
    const list = listFor(index)
    blockBoundsFor(list, columns)
    for (let internalId = 1000; internalId < 1300; internalId++) insertDocument(index, internalId, (internalId % 9) + 1)
    const extended = blockBoundsFor(list, columns)
    expectBoundsMatchRecount(list, columns, extended)
    expect(liveDocumentTotal(extended)).toBe(1300)

    const scratchIndex = newIndex()
    for (let internalId = 0; internalId < 1300; internalId++) {
      insertDocument(scratchIndex, internalId, (internalId % 9) + 1)
    }
    const rebuilt = blockBoundsFor(listFor(scratchIndex), columns)
    expect(extended.blockCount).toBe(rebuilt.blockCount)
    expect(Array.from(extended.entryEnd.subarray(0, extended.blockCount))).toEqual(
      Array.from(rebuilt.entryEnd.subarray(0, rebuilt.blockCount)),
    )
    expect(Array.from(extended.maxTermFrequency.subarray(0, extended.blockCount))).toEqual(
      Array.from(rebuilt.maxTermFrequency.subarray(0, rebuilt.blockCount)),
    )
    expect(Array.from(extended.minFieldLength.subarray(0, extended.blockCount))).toEqual(
      Array.from(rebuilt.minFieldLength.subarray(0, rebuilt.blockCount)),
    )
    expect(Array.from(extended.maxEntriesPerDocument.subarray(0, extended.blockCount))).toEqual(
      Array.from(rebuilt.maxEntriesPerDocument.subarray(0, rebuilt.blockCount)),
    )
    expect(Array.from(extended.documentCount.subarray(0, extended.blockCount))).toEqual(
      Array.from(rebuilt.documentCount.subarray(0, rebuilt.blockCount)),
    )
  })

  it('excludes tombstoned documents from every summary, before and after appends', () => {
    const index = newIndex()
    for (let internalId = 0; internalId < 600; internalId++) insertDocument(index, internalId, (internalId % 9) + 1)
    index.insert(TERM, 600, 50, 0, null)
    const columns = columnsFor(1000)
    const list = listFor(index)
    index.remove(TERM, 600)
    expect(list.deletedDocs.size).toBe(1)
    const afterRemove = blockBoundsFor(list, columns)
    expectBoundsMatchRecount(list, columns, afterRemove)
    expect(liveDocumentTotal(afterRemove)).toBe(600)
    for (let block = 0; block < afterRemove.blockCount; block++) {
      expect(afterRemove.maxTermFrequency[block]).toBeLessThan(50)
    }

    for (let internalId = 601; internalId < 800; internalId++) insertDocument(index, internalId, (internalId % 9) + 1)
    const extended = blockBoundsFor(list, columns)
    expectBoundsMatchRecount(list, columns, extended)
    expect(liveDocumentTotal(extended)).toBe(799)
  })

  it('rebuilds after compaction clears the tombstones', () => {
    const index = newIndex()
    for (let internalId = 0; internalId < 200; internalId++) insertDocument(index, internalId, (internalId % 9) + 1)
    const columns = columnsFor(200)
    const list = listFor(index)
    blockBoundsFor(list, columns)
    for (let internalId = 0; internalId < 100; internalId++) index.remove(TERM, internalId)
    expect(list.deletedDocs.size).toBeLessThan(100)
    const bounds = blockBoundsFor(list, columns)
    expectBoundsMatchRecount(list, columns, bounds)
    expect(liveDocumentTotal(bounds)).toBe(100)
  })
})
