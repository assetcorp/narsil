import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ErrorCodes } from '../../errors'
import { createNarsil, type Narsil } from '../../narsil'
import type { FieldFilter } from '../../types/filters'
import type { IndexConfig } from '../../types/schema'

const config: IndexConfig = {
  schema: {
    title: 'string',
    code: 'verbatim:sortable',
    name: 'string:pattern:sortable',
    tags: 'string[]:sortable',
    label: 'verbatim',
    price: 'number',
  },
  partitions: { maxPartitions: 2 },
}

const invoices: Array<{ id: string; code?: string; name?: string }> = [
  { id: 'c1', code: 'INV-2023-900', name: 'apple' },
  { id: 'c2', code: 'INV-2024', name: 'Apple' },
  { id: 'c3', code: 'inv-2024-001', name: 'Banana' },
  { id: 'c4', code: 'INV-2024-002', name: 'fuss' },
  { id: 'c5', code: 'INV-2025', name: 'Fuß' },
  { id: 'c6', code: 'INV-2025-000', name: 'FUSS' },
  { id: 'c7', code: 'Inv-2024-001', name: 'école' },
  { id: 'c8' },
]

async function load(narsil: Narsil): Promise<void> {
  await narsil.createIndex('invoices', config)
  for (const { id, ...fields } of invoices) {
    await narsil.insert('invoices', { title: `invoice ${id}`, label: 'x', tags: ['a'], price: 1, ...fields }, id)
  }
}

async function idsWhere(narsil: Narsil, field: string, filter: FieldFilter): Promise<string[]> {
  const result = await narsil.query('invoices', {
    term: 'invoice',
    filters: { fields: { [field]: filter } },
    limit: 50,
  })
  return result.hits.map(hit => hit.id).sort()
}

describe('a range test on a sortable text field', () => {
  let narsil: Narsil

  beforeEach(async () => {
    narsil = await createNarsil({ workers: { enabled: false } })
    await load(narsil)
  })

  afterEach(async () => {
    await narsil.shutdown()
  })

  it('returns exactly the documents whose values lie within the bounds in sort order, before and after writes', async () => {
    expect(await idsWhere(narsil, 'code', { between: ['INV-2024', 'INV-2025'] })).toEqual([
      'c2',
      'c3',
      'c4',
      'c5',
      'c7',
    ])
    expect(await idsWhere(narsil, 'code', { gt: 'inv-2024-001' })).toEqual(['c4', 'c5', 'c6'])
    expect(await idsWhere(narsil, 'code', { gte: 'Inv-2024-001' })).toEqual(['c3', 'c4', 'c5', 'c6', 'c7'])
    expect(await idsWhere(narsil, 'code', { lt: 'INV-2024' })).toEqual(['c1'])
    expect(await idsWhere(narsil, 'code', { lte: 'inv-2024' })).toEqual(['c1', 'c2'])
    expect(await idsWhere(narsil, 'code', { gte: 'INV-2024-002', lt: 'INV-2025-000' })).toEqual(['c4', 'c5'])
    expect(await idsWhere(narsil, 'code', { between: ['INV-2025', 'INV-2024'] })).toEqual([])
    expect(await idsWhere(narsil, 'name', { gte: 'FUSS', lt: 'zebra' })).toEqual(['c4', 'c5', 'c6'])
    expect(await idsWhere(narsil, 'name', { gt: 'Fuß', lte: 'fuss' })).toEqual(['c4'])
    expect(await idsWhere(narsil, 'name', { gt: 'zebra' })).toEqual(['c7'])

    await narsil.insert('invoices', { title: 'invoice c9', code: 'INV-2024-5' }, 'c9')
    await narsil.update('invoices', 'c4', { title: 'invoice c4', code: 'INV-2026' })
    await narsil.remove('invoices', 'c3')

    expect(await idsWhere(narsil, 'code', { between: ['INV-2024', 'INV-2025'] })).toEqual(['c2', 'c5', 'c7', 'c9'])
    expect(await idsWhere(narsil, 'code', { gt: 'INV-2025-000' })).toEqual(['c4'])
  })

  it('raises SEARCH_INVALID_FILTER for a text bound on any field other than a single sortable text field', async () => {
    const refused: Array<[string, FieldFilter]> = [
      ['tags', { gte: 'a' }],
      ['title', { lt: 'invoice' }],
      ['label', { between: ['a', 'z'] }],
      ['price', { gt: 'a' }],
      ['undeclared', { lte: 'a' }],
      ['code', { between: ['a', 1] } as unknown as FieldFilter],
    ]
    for (const [field, filter] of refused) {
      await expect(idsWhere(narsil, field, filter)).rejects.toMatchObject({ code: ErrorCodes.SEARCH_INVALID_FILTER })
    }
  })
})

describe('a range test on a reopened index', () => {
  let root: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'narsil-text-range-'))
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('answers from the segments that recovery loads, and leaves out a document removed after the reopen', async () => {
    const writer = await createNarsil({ workers: { enabled: false }, durability: { directory: root } })
    await load(writer)
    await writer.checkpoint('invoices')
    await writer.shutdown()

    const reader = await createNarsil({ workers: { enabled: false }, durability: { directory: root } })
    try {
      expect(await idsWhere(reader, 'code', { between: ['INV-2024', 'INV-2025'] })).toEqual([
        'c2',
        'c3',
        'c4',
        'c5',
        'c7',
      ])
      await reader.remove('invoices', 'c5')
      expect(await idsWhere(reader, 'code', { between: ['INV-2024', 'INV-2025'] })).toEqual(['c2', 'c3', 'c4', 'c7'])
    } finally {
      await reader.shutdown()
    }
  })
})
