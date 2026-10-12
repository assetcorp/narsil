import { afterEach, describe, expect, it } from 'vitest'
import { ErrorCodes, NarsilError } from '../../../errors'
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

const CONFIG: IndexConfig = {
  schema: {
    title: 'string',
    price: 'number',
    inStock: 'boolean',
    category: 'enum',
    location: 'geopoint',
    meta: { maker: 'string', ratings: 'number[]' },
    embedding: 'vector[3]',
  },
  language: 'english',
}

const EXACT_NUMBERS = [0.1 + 0.2, 1e308, 5e-324, 2 ** 53 - 1, -1.5e-7, 123456789.98765433]

function documentsFor(count: number): Map<string, AnyDocument> {
  const documents = new Map<string, AnyDocument>()
  for (let n = 0; n < count; n++) {
    documents.set(`doc-${n}`, {
      title: n % 7 === 0 ? `Ålesund "quoted" \\ line\u0001 ${n} 😀` : `harbour lantern ${n}`,
      price: EXACT_NUMBERS[n % EXACT_NUMBERS.length] * (n % 2 === 0 ? 1 : -1),
      inStock: n % 2 === 0,
      category: ['tools', 'garden'][n % 2],
      location: { lat: (n % 170) - 85 + 0.125, lon: (n % 350) - 175 + 0.5 },
      meta: { maker: `maker ${n % 3}`, ratings: [n, n + 0.5, -n - 1] },
      embedding: [n % 2 === 0 ? -0 : 0.25, Math.fround(n / 7), Math.fround(-n / 3)],
    })
  }
  return documents
}

function parseLines(text: string): unknown[] {
  return text
    .split('\n')
    .filter(line => line.length > 0)
    .map(line => JSON.parse(line))
}

async function exportText(engine: Narsil, indexName: string): Promise<string> {
  return new TextDecoder().decode(await bytesOf(await engine.exportDocuments(indexName)))
}

async function sourceWith(kindIndex: number, documents: Map<string, AnyDocument>): Promise<Narsil> {
  const engine = track((await ENGINE_KINDS[kindIndex].open(roots)).engine)
  await engine.createIndex('catalog', CONFIG)
  const result = await engine.insertBatch(
    'catalog',
    [...documents].map(([id, document]) => ({ id, ...document })),
  )
  expect(result.failed).toEqual([])
  return engine
}

describe.each(ENGINE_KINDS.map((kind, index) => ({ name: kind.name, index })))('a document export of $name', kind => {
  it('writes a header line and every document exactly once, with exact numbers and negative zero', async () => {
    const documents = documentsFor(60)
    const engine = await sourceWith(kind.index, documents)
    await engine.remove('catalog', 'doc-3')
    documents.delete('doc-3')

    const [header, ...lines] = parseLines(await exportText(engine, 'catalog')) as Array<Record<string, unknown>>

    expect(header.format).toBe('narsil-export')
    expect(header.version).toBe(1)
    expect((header.index as Record<string, unknown>).schema).toEqual(CONFIG.schema)
    expect(lines.map(line => line.id).sort()).toEqual([...documents.keys()].sort())
    for (const line of lines) {
      const expected = documents.get(line.id as string)
      expect({ ...line, embedding: undefined }).toEqual({ id: line.id, ...expected, embedding: undefined })
      const embedding = line.embedding as number[]
      const original = expected?.embedding as number[]
      embedding.forEach((value, at) => {
        expect(Object.is(value, Math.fround(original[at]))).toBe(true)
      })
    }
  })

  it('imports into another engine an index equal to the source, and an import run again converges', async () => {
    const documents = documentsFor(40)
    const engine = await sourceWith(kind.index, documents)
    const exported = await exportText(engine, 'catalog')

    const target = track((await ENGINE_KINDS[1 - kind.index].open(roots)).engine)
    const first = await target.importDocumentExport('copy', new TextEncoder().encode(exported))
    await target.update('copy', 'doc-5', { ...documents.get('doc-5'), title: 'changed after the import' })
    await target.insert('copy', { ...documents.get('doc-6'), title: 'not in the export' }, 'extra')
    const second = await target.importDocumentExport('copy', new TextEncoder().encode(exported))

    expect(first).toEqual({ imported: 40, refusedCount: 0, refused: [] })
    expect(second).toEqual({ imported: 40, refusedCount: 0, refused: [] })
    expect(await target.countDocuments('copy')).toBe(41)
    for (const [id, document] of documents) {
      const stored = await target.get('copy', id)
      expect({ ...stored, embedding: undefined }).toEqual({ id, ...document, embedding: undefined })
      const embedding = Array.from(stored?.embedding as Float32Array)
      embedding.forEach((value, at) => {
        expect(Object.is(value, Math.fround((document.embedding as number[])[at]))).toBe(true)
      })
    }
    const query = { vector: { field: 'embedding', value: [0.25, 1, -2] }, limit: 3 }
    expect((await target.query('copy', query)).hits.map(hit => hit.id)).toEqual(
      (await engine.query('catalog', query)).hits.map(hit => hit.id),
    )
  })
})

describe('reading a hostile document export', () => {
  async function engineWithIndex(): Promise<Narsil> {
    const engine = track(await createNarsil({ workers: { enabled: false } }))
    await engine.createIndex('catalog', CONFIG)
    return engine
  }

  function header(schema: IndexConfig['schema'] = CONFIG.schema): string {
    return JSON.stringify({ format: 'narsil-export', version: 1, index: { schema, language: 'english' } })
  }

  it('refuses a missing or foreign header with CONFIG_INVALID and writes nothing', async () => {
    const engine = await engineWithIndex()
    for (const text of [
      '',
      'not json\n',
      '{"format":"other","version":1,"index":{}}\n',
      '{"format":"narsil-export","version":2,"index":{"schema":{"title":"string"}}}\n',
      '[1,2,3]\n',
      `${header({ title: 'number' })}\n{"id":"a","title":1}\n`,
    ]) {
      await expect(engine.importDocumentExport('catalog', new TextEncoder().encode(text))).rejects.toMatchObject({
        code: ErrorCodes.CONFIG_INVALID,
      })
    }
    expect(await engine.countDocuments('catalog')).toBe(0)
  })

  it('refuses each line it cannot write, reports its line number, and imports the rest', async () => {
    const engine = await engineWithIndex()
    const lines = [
      header(),
      '{"id":"good-1","title":"harbour","price":1}',
      'this is not json',
      '"a string"',
      '{"title":"no id"}',
      '{"id":"","title":"empty id"}',
      '',
      '{"id":"bad-price","title":"x","price":"twelve"}',
      '{"id":"good-2","title":"lantern","price":2}\r',
      '{"id":"good-3","embedding":[1,2]}',
    ]
    const bytes = new Uint8Array([...new TextEncoder().encode(lines.join('\n')), 0x0a, 0xff, 0xfe, 0x0a])

    const result = await engine.importDocumentExport('catalog', bytes)

    expect(result.imported).toBe(2)
    expect(result.refused.map(refusal => refusal.line)).toEqual([3, 4, 5, 6, 8, 10, 11])
    expect(result.refusedCount).toBe(7)
    expect(result.refused.map(refusal => refusal.code)).toEqual([
      ErrorCodes.DOC_VALIDATION_FAILED,
      ErrorCodes.DOC_VALIDATION_FAILED,
      ErrorCodes.DOC_VALIDATION_FAILED,
      ErrorCodes.DOC_VALIDATION_FAILED,
      ErrorCodes.DOC_VALIDATION_FAILED,
      ErrorCodes.VECTOR_DIMENSION_MISMATCH,
      ErrorCodes.DOC_VALIDATION_FAILED,
    ])
    expect(await engine.get('catalog', 'good-2')).toEqual({ id: 'good-2', title: 'lantern', price: 2 })
    expect(await engine.countDocuments('catalog')).toBe(2)
  })

  it('reports the first 1,000 refusals and counts every one', async () => {
    const engine = await engineWithIndex()
    const text = [header(), ...Array.from({ length: 1_500 }, () => 'nope')].join('\n')

    const result = await engine.importDocumentExport('catalog', new TextEncoder().encode(text))

    expect(result.refusedCount).toBe(1_500)
    expect(result.refused).toHaveLength(1_000)
    expect(result.refused[999].line).toBe(1_001)
  })

  it('reports the lowest 1,000 refused lines when a batch refuses a document after later lines fail to parse', async () => {
    const engine = await engineWithIndex()
    const text = [
      header(),
      '{"id":"bad-price","title":"x","price":"twelve"}',
      ...Array.from({ length: 1_200 }, () => 'nope'),
    ].join('\n')

    const result = await engine.importDocumentExport('catalog', new TextEncoder().encode(text))
    const lines = result.refused.map(refusal => refusal.line)

    expect(result.refusedCount).toBe(1_201)
    expect(lines).toEqual(Array.from({ length: 1_000 }, (_, at) => at + 2))
    expect(result.refused[0].code).toBe(ErrorCodes.DOC_VALIDATION_FAILED)
    expect(result.refused[0].message).not.toBe('The line is not JSON')
  })

  it('refuses to export a document that holds a value JSON cannot carry', async () => {
    const engine = track(await createNarsil({ workers: { enabled: false } }))
    await engine.createIndex('files', { schema: { title: 'string' } })
    await engine.insert('files', { title: 'scan', thumbnail: new Uint8Array([1, 2, 3]) }, 'scan')

    try {
      await bytesOf(await engine.exportDocuments('files'))
      throw new Error('the export carried raw bytes')
    } catch (error) {
      expect(error).toBeInstanceOf(NarsilError)
      expect((error as NarsilError).code).toBe(ErrorCodes.DOC_VALIDATION_FAILED)
    }
  })
})
