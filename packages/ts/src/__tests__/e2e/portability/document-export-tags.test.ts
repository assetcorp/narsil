import { Buffer } from 'node:buffer'
import { afterEach, describe, expect, it } from 'vitest'
import { ErrorCodes } from '../../../errors'
import { createNarsil, type Narsil } from '../../../narsil'
import type { AnyDocument, IndexConfig } from '../../../types/schema'
import { bytesOf } from './archive-oracle'
import { ENGINE_KINDS, temporaryRoots } from './harness'

const roots = temporaryRoots()
const engines: Narsil[] = []

afterEach(async () => {
  for (const engine of engines.splice(0)) await engine.shutdown().catch(() => undefined)
  await roots.removeAll()
})

function track(engine: Narsil): Narsil {
  engines.push(engine)
  return engine
}

const CONFIG: IndexConfig = { schema: { title: 'string' }, language: 'english' }
const HEADER = JSON.stringify({
  format: 'narsil-export',
  version: 1,
  index: { schema: CONFIG.schema, language: 'english' },
})
const DATE_RANGE_MS = 8_640_000_000_000_000
const NESTING_LIMIT = 32

const DATES = [0, -1, -999, -1_000, -1_001, 1, 999, 1_700_000_000_123, -DATE_RANGE_MS, DATE_RANGE_MS].map(
  milliseconds => new Date(milliseconds),
)
const BYTES = [0, 1, 2, 3, 4, 5, 255, 256].map(length => Uint8Array.from({ length }, (_, at) => (at * 37 + 11) & 0xff))
const LARGE_BYTES = Uint8Array.from({ length: 300_001 }, (_, at) => (at * 131 + (at >> 8)) & 0xff)

function nestedAtLimit(): Record<string, unknown> {
  let inner: Record<string, unknown> = { $leaf: new Date(5), blob: new Uint8Array([7]) }
  for (let level = 0; level < NESTING_LIMIT - 2; level++) inner = { [`level${level}`]: inner }
  return inner
}

const DOCUMENTS: Record<string, AnyDocument> = {
  dates: { title: 'dates', when: DATES[0], history: DATES.slice(1) },
  bytes: { title: 'bytes', blobs: BYTES, large: LARGE_BYTES },
  numbers: {
    title: 'numbers',
    values: [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -0, 0, 5e-324],
  },
  dollars: {
    title: 'dollars',
    money: { $: 1 },
    tagLike: { $date: [1, 2] },
    inner: [{ $bytes: 'AQID' }, { $object: { $number: 'NaN' } }],
    pair: { $a: 1, $b: Number.NaN },
    text: '{"$date":[1,2]}',
    empty: {},
  },
  deep: { title: 'deep', nest: nestedAtLimit() },
}

function dateTagOf(date: Date): [number, number] {
  const milliseconds = BigInt(date.getTime())
  const seconds = milliseconds >= 0n ? milliseconds / 1_000n : -((-milliseconds + 999n) / 1_000n)
  return [Number(seconds), Number((milliseconds - seconds * 1_000n) * 1_000_000n)]
}

function taggedForm(value: unknown): unknown {
  if (value instanceof Date) return { $date: dateTagOf(value) }
  if (value instanceof Uint8Array) return { $bytes: Buffer.from(value).toString('base64') }
  if (typeof value === 'number' && !Number.isFinite(value)) return { $number: String(value) }
  if (Array.isArray(value)) return value.map(taggedForm)
  if (value === null || typeof value !== 'object') return value
  const entries = Object.entries(value).map(([key, entry]) => [key, taggedForm(entry)] as const)
  const map = Object.fromEntries(entries)
  return entries.length === 1 && entries[0][0].startsWith('$') ? { $object: map } : map
}

async function exportLinesOf(engine: Narsil, indexName: string): Promise<string[]> {
  const text = new TextDecoder().decode(await bytesOf(await engine.exportDocuments(indexName)))
  return text.split('\n').filter(line => line.length > 0)
}

describe.each(
  ENGINE_KINDS.map((kind, index) => ({ name: kind.name, index })),
)('tags in a document export of $name', kind => {
  it('writes dates, bytes, non-finite numbers, and dollar maps as tags, and imports them back unchanged', async () => {
    const engine = track((await ENGINE_KINDS[kind.index].open(roots)).engine)
    await engine.createIndex('mixed', CONFIG)
    const inserted = await engine.insertBatch(
      'mixed',
      Object.entries(DOCUMENTS).map(([id, document]) => ({ id, ...document })),
    )
    expect(inserted.failed).toEqual([])

    const [, ...lines] = await exportLinesOf(engine, 'mixed')
    const byId = new Map(lines.map(line => [(JSON.parse(line) as { id: string }).id, JSON.parse(line)]))
    expect([...byId.keys()].sort()).toEqual(Object.keys(DOCUMENTS).sort())
    for (const [id, document] of Object.entries(DOCUMENTS)) {
      expect(byId.get(id)).toEqual(taggedForm({ id, ...document }))
    }

    const target = track((await ENGINE_KINDS[1 - kind.index].open(roots)).engine)
    const text = `${[HEADER, ...lines].join('\n')}\n`
    const result = await target.importDocumentExport('copy', new TextEncoder().encode(text))
    expect(result).toEqual({ imported: Object.keys(DOCUMENTS).length, refusedCount: 0, refused: [] })
    for (const [id, document] of Object.entries(DOCUMENTS)) {
      expect(await target.get('copy', id)).toEqual({ id, ...document })
    }
    const reexported = await exportLinesOf(target, 'copy')
    expect(new Set(reexported.slice(1))).toEqual(new Set(lines))
  })
})

describe('reading hostile tags in a document export', () => {
  const ACCEPTED: Record<string, { line: string; value: unknown }> = {
    escaped: { line: '{"\\u0024bytes":"AQID"}', value: new Uint8Array([1, 2, 3]) },
    oneByte: { line: '{"$bytes":"AQ=="}', value: new Uint8Array([1]) },
    beforeEpoch: { line: '{"$date":[-1,999000000]}', value: new Date(-1) },
    wrapped: { line: '{"$object":{"$nope":{"$number":"-Infinity"}}}', value: { $nope: Number.NEGATIVE_INFINITY } },
    pair: { line: '{"$a":1,"$b":{"$number":"NaN"}}', value: { $a: 1, $b: Number.NaN } },
    tagWithExtra: { line: '{"$bytes":"AQID","extra":1}', value: { $bytes: 'AQID', extra: 1 } },
    tagInText: { line: '"{\\"$date\\":[1,2]}"', value: '{"$date":[1,2]}' },
  }

  const REFUSED = [
    '{"$nope":1}',
    '{"$":1}',
    '{"\\u0024nope":1}',
    '{"$bytes":"AQI"}',
    '{"$bytes":"AQJ="}',
    '{"$bytes":"AR=="}',
    '{"$bytes":"A=QI"}',
    '{"$bytes":"AQ-_"}',
    '{"$bytes":"AQID===="}',
    '{"$bytes":" AQI"}',
    '{"$bytes":5}',
    '{"$date":"2020-01-01"}',
    '{"$date":[0]}',
    '{"$date":[0,0,0]}',
    '{"$date":[1.5,0]}',
    '{"$date":[0,1000000000]}',
    '{"$date":[0,-1]}',
    '{"$date":[0,0.5]}',
    '{"$date":["0",0]}',
    '{"$date":[9007199254740992,0]}',
    '{"$date":[8640000000001,0]}',
    '{"$date":[-8640000000001,0]}',
    '{"$number":"nan"}',
    '{"$number":"Infinity "}',
    '{"$number":5}',
    '{"$object":[1]}',
    '{"$object":"x"}',
    '{"$object":null}',
    '{"$object":{"__proto__":{"$number":"NaN"}}}',
    '{"a":{"__proto__":{"polluted":{"$number":"NaN"}}}}',
    `${'['.repeat(NESTING_LIMIT + 8)}{"$number":"NaN"}${']'.repeat(NESTING_LIMIT + 8)}`,
  ]

  it('refuses each malformed tag on its own line and imports every other line', async () => {
    const engine = track(await createNarsil({ workers: { enabled: false } }))
    const accepted = Object.entries(ACCEPTED).map(([id, entry]) => `{"id":"${id}","x":${entry.line}}`)
    const refused = REFUSED.map((value, at) => `{"id":"refused-${at}","x":${value}}`)
    const text = `${[HEADER, ...accepted, ...refused].join('\n')}\n`

    const result = await engine.importDocumentExport('hostile', new TextEncoder().encode(text))

    expect(result.imported).toBe(accepted.length)
    expect(result.refusedCount).toBe(refused.length)
    expect(result.refused.map(refusal => refusal.line)).toEqual(refused.map((_, at) => at + accepted.length + 2))
    for (const refusal of result.refused) expect(refusal.code).toBe(ErrorCodes.DOC_VALIDATION_FAILED)
    for (const [id, entry] of Object.entries(ACCEPTED)) {
      expect(await engine.get('hostile', id)).toEqual({ id, x: entry.value })
    }
    expect(await engine.countDocuments('hostile')).toBe(accepted.length)
    expect(Object.hasOwn(Object.prototype, 'polluted')).toBe(false)
  })

  it('carries an ID of 512 escaped control characters through an export and refuses one of 513', async () => {
    const source = track(await createNarsil({ workers: { enabled: false } }))
    await source.createIndex('ids', CONFIG)
    const longest = '\u0001'.repeat(512)
    await source.insert('ids', { title: 'longest', blob: new Uint8Array(0) }, longest)
    await expect(source.insert('ids', { title: 'too long' }, '\u0001'.repeat(513))).rejects.toMatchObject({
      code: ErrorCodes.DOC_VALIDATION_FAILED,
    })

    const [header, line] = await exportLinesOf(source, 'ids')
    expect(line).toBe(`{"id":"${'\\u0001'.repeat(512)}","title":"longest","blob":{"$bytes":""}}`)
    const tooLong = line.replace(`"id":"`, `"id":"\\u0001`)
    const target = track(await createNarsil({ workers: { enabled: false } }))
    const result = await target.importDocumentExport(
      'ids',
      new TextEncoder().encode(`${header}\n${line}\n${tooLong}\n`),
    )

    expect(result.imported).toBe(1)
    expect(result.refused.map(refusal => [refusal.line, refusal.code])).toEqual([[3, ErrorCodes.DOC_VALIDATION_FAILED]])
    expect(await target.get('ids', longest)).toEqual({ id: longest, title: 'longest', blob: new Uint8Array(0) })
  })

  it('refuses an invalid date when a document is written', async () => {
    const engine = track(await createNarsil({ workers: { enabled: false } }))
    await engine.createIndex('dates', CONFIG)

    await expect(engine.insert('dates', { title: 'x', when: new Date(Number.NaN) }, 'bad')).rejects.toMatchObject({
      code: ErrorCodes.DOC_VALIDATION_FAILED,
    })
    const batch = await engine.insertBatch('dates', [{ id: 'nested', title: 'x', at: [{ when: new Date('nope') }] }])
    expect(batch.failed.map(failure => failure.docId)).toEqual(['nested'])
    expect(await engine.countDocuments('dates')).toBe(0)
  })
})
