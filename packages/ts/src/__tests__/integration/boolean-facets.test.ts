import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createNarsil, type Narsil } from '../../narsil'

type Stock = {
  id: string
  title: string
  active: boolean
  flags?: boolean[]
}

async function checkCounts(engine: Narsil, rows: ReadonlyMap<string, Stock>): Promise<void> {
  await engine.waitForWrites('stock')
  const expectedFlags: Record<string, number> = {}
  const expectedActive: Record<string, number> = {}
  let count = 0
  for (const row of rows.values()) {
    if (row.active) continue
    count++
    const key = String(row.active)
    expectedActive[key] = (expectedActive[key] ?? 0) + 1
    for (const flag of [false, true]) {
      if (row.flags?.includes(flag)) expectedFlags[String(flag)] = (expectedFlags[String(flag)] ?? 0) + 1
    }
  }
  const answer = await engine.query('stock', {
    term: 'catalogue',
    limit: 0,
    filters: { fields: { active: { eq: false } } },
    facets: { flags: {}, active: {} },
  })
  expect(answer.count).toBe(count)
  expect(answer.facets?.flags.values).toEqual(expectedFlags)
  expect(answer.facets?.active.values).toEqual(expectedActive)
  expect(answer.facets?.flags.errorBound).toBe(0)
}

describe('boolean facets across writes and recovery', () => {
  it('counts each boolean once per matched document through worker recovery', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'narsil-boolean-facets-'))
    const options = { workers: { enabled: true, count: 2, promotionThreshold: 10 }, durability: { directory } }
    let engine = await createNarsil(options)
    const rows = new Map<string, Stock>()
    try {
      await engine.createIndex('stock', { schema: { title: 'string', active: 'boolean', flags: 'boolean[]' } })
      const promotion = new Promise(resolve => {
        engine.on('workerPromote', resolve)
        engine.on('workerPromoteFailure', resolve)
      })
      for (let index = 0; index < 96; index++) {
        const row: Stock = { id: `item-${index}`, title: 'catalogue', active: index % 2 === 0 }
        if (index % 5 !== 0) row.flags = index % 3 === 0 ? [true, false, true] : [index % 2 === 0]
        rows.set(row.id, row)
      }
      expect((await engine.insertBatch('stock', Array.from(rows.values()))).failed).toEqual([])
      expect(await promotion).toMatchObject({ workerCount: 1 })
      await checkCounts(engine, rows)
      for (let index = 0; index < 96; index++) {
        const row = rows.get(`item-${index}`)
        if (row === undefined) continue
        if (index % 7 === 0) {
          await engine.remove('stock', row.id)
          rows.delete(row.id)
        } else if (index % 4 === 0) {
          row.active = !row.active
          row.flags = [false, false]
          await engine.update('stock', row.id, row)
        }
      }
      await checkCounts(engine, rows)
      await engine.checkpoint('stock')
      await engine.shutdown()
      engine = await createNarsil(options)
      await checkCounts(engine, rows)
      await engine.insert('stock', { title: 'catalogue', active: false, flags: [true, false] }, 'replacement')
      rows.set('replacement', { id: 'replacement', title: 'catalogue', active: false, flags: [true, false] })
      await checkCounts(engine, rows)
    } finally {
      await engine.shutdown()
      await rm(directory, { recursive: true, force: true })
    }
  })
})
