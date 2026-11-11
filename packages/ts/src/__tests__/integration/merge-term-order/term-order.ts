import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createNarsil, type Narsil, registerTokenizer } from '../../../index'
import { BACKEND_NAMES, backendAvailable, type SearchBackend, searchThrough } from '../filtered-vectors/search-backend'

const INDEX = 'glyphs'
const TOKENIZER = 'space-separated-glyph-terms'
const COPIES = 3
const TEST_TIMEOUT_MS = 120_000
const CHARACTERS = ['\u{10000}', '\u{1F600}', '\u{1D49C}', '', 'Ａ', '�', '￮', 'z', 'a']
const TERMS = CHARACTERS.flatMap(first => CHARACTERS.map(second => `k${first}${second}`))

type Row = {
  id: string
  body: string
  term: string
}

function codePointOrder(left: string, right: string): number {
  const a = Array.from(left, character => character.codePointAt(0) ?? 0)
  const b = Array.from(right, character => character.codePointAt(0) ?? 0)
  for (let at = 0; at < Math.min(a.length, b.length); at++) if (a[at] !== b[at]) return a[at] - b[at]
  return a.length - b.length
}

function rowsOfCopy(copy: number): Row[] {
  const rows = TERMS.map((term, at) => ({ id: `glyph-${copy}-${at}`, body: `shared ${term}`, term }))
  return rows.filter((_, at) => at % 2 === 1).concat(rows.filter((_, at) => at % 2 === 0).reverse())
}

async function verify(engine: Narsil, rows: ReadonlyMap<string, Row>): Promise<void> {
  const shared = await engine.query(INDEX, { term: 'shared', limit: 1_000 })
  expect(shared.hits.map(hit => hit.id).sort()).toEqual([...rows.keys()].sort())
  const holders = new Map<string, string[]>()
  for (const row of rows.values()) holders.set(row.term, [...(holders.get(row.term) ?? []), row.id])
  for (const term of TERMS) {
    const found = await engine.query(INDEX, { term, limit: 100 })
    expect(found.hits.map(hit => hit.id).sort()).toEqual((holders.get(term) ?? []).sort())
  }
  const expected = [...holders]
    .sort((left, right) => right[1].length - left[1].length || codePointOrder(left[0], right[0]))
    .map(([term]) => term)
  const suggested = await engine.suggest(INDEX, { prefix: 'k', limit: TERMS.length })
  expect(suggested.terms.map(entry => entry.term)).toEqual(expected)
}

export function describeMergedTermOrder(backend: SearchBackend): void {
  describe.skipIf(!backendAvailable(backend))(`merged term order through ${BACKEND_NAMES[backend]}`, () => {
    searchThrough(backend)

    it(
      'keeps supplementary characters after U+E000 to U+FFFF through segment merges, removals, recovery, and restore',
      async () => {
        registerTokenizer(TOKENIZER, {
          tokenize: text =>
            text
              .split(' ')
              .filter(Boolean)
              .map((token, position) => ({ token, position })),
        })
        const directory = await mkdtemp(join(tmpdir(), 'narsil-merge-term-order-'))
        const options = { workers: { enabled: false }, durability: { directory, compactionThreshold: 1 } }
        let engine = await createNarsil(options)
        const rows = new Map<string, Row>()
        let restored: Narsil | undefined
        try {
          await engine.createIndex(INDEX, {
            schema: { body: 'string' },
            tokenizer: TOKENIZER,
            partitions: { maxPartitions: 1 },
          })
          for (let copy = 0; copy < COPIES; copy++) {
            const batch = rowsOfCopy(copy)
            expect((await engine.insertBatch(INDEX, batch)).failed).toEqual([])
            for (const row of batch) rows.set(row.id, row)
            await engine.checkpoint(INDEX)
          }
          await verify(engine, rows)
          for (let at = 0; at < TERMS.length; at += 4) {
            await engine.remove(INDEX, `glyph-1-${at}`)
            rows.delete(`glyph-1-${at}`)
          }
          await engine.checkpoint(INDEX)
          await verify(engine, rows)
          await engine.shutdown()
          engine = await createNarsil(options)
          await verify(engine, rows)
          restored = await createNarsil({ workers: { enabled: false } })
          await restored.restore(INDEX, await engine.snapshot(INDEX))
          await verify(restored, rows)
        } finally {
          await restored?.shutdown()
          await engine.shutdown()
          await rm(directory, { recursive: true, force: true })
        }
      },
      TEST_TIMEOUT_MS,
    )
  })
}
