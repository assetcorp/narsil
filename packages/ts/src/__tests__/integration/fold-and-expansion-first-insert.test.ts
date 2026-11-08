import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Narsil } from '../../narsil'

const SEARCHED_WORD = 'record'
const engines: Narsil[] = []

afterEach(async () => {
  for (const engine of engines.splice(0)) await engine.shutdown()
})

async function freshEngine(): Promise<Narsil> {
  vi.resetModules()
  const { createNarsil } = await import('../../index')
  const engine = await createNarsil({ workers: { enabled: false } })
  engines.push(engine)
  return engine
}

const PART_CODES = ['AX-7701', 'ax-7702', 'BX-7703', 'AX-8804', 'Café-AX-9905', 'QX-1106']

function partsWhoseCodeHolds(fragment: string, caseFold: boolean): string[] {
  const wanted = caseFold ? fragment.toLowerCase() : fragment
  return PART_CODES.map((code, at) => ({ id: `part-${at}`, code: caseFold ? code.toLowerCase() : code }))
    .filter(part => part.code.includes(wanted))
    .map(part => part.id)
    .sort()
}

const WORKSHOP_TITLES = ['oilskin coat', 'deerskin glove', 'bench vice', 'table lamp', 'calfskin boot']

function titlesWithWordHolding(fragment: string): string[] {
  return WORKSHOP_TITLES.map((title, at) => ({ id: `tool-${at}`, title }))
    .filter(tool => tool.title.split(' ').some(word => word.includes(fragment)))
    .map(tool => tool.id)
    .sort()
}

describe('the first insert into a pattern or partial-word index on a fresh module graph', () => {
  it('builds the pattern index on the first verbatim insert and answers contains filters', async () => {
    const engine = await freshEngine()
    await engine.createIndex('parts', { schema: { body: 'string', code: 'verbatim' } })
    await engine.insert('parts', { body: `${SEARCHED_WORD} first`, code: PART_CODES[0] }, 'part-0')
    for (const [at, code] of PART_CODES.entries()) {
      if (at > 0) await engine.insert('parts', { body: `${SEARCHED_WORD} part`, code }, `part-${at}`)
    }
    for (const caseFold of [false, true]) {
      const result = await engine.query('parts', {
        term: SEARCHED_WORD,
        filters: { fields: { code: { contains: 'AX-', caseFold } } },
        limit: PART_CODES.length,
      })
      expect(result.hits.map(hit => hit.id).sort(), `caseFold ${caseFold}`).toEqual(
        partsWhoseCodeHolds('AX-', caseFold),
      )
    }
  }, 30_000)

  it('records partial words on the first insert and expands an inner fragment', async () => {
    const engine = await freshEngine()
    await engine.createIndex('workshop', { schema: { title: 'string:partial' } })
    await engine.insert('workshop', { title: WORKSHOP_TITLES[0] }, 'tool-0')
    for (const [at, title] of WORKSHOP_TITLES.entries()) {
      if (at > 0) await engine.insert('workshop', { title }, `tool-${at}`)
    }
    const result = await engine.query('workshop', { term: 'skin', partialWords: true, limit: WORKSHOP_TITLES.length })
    expect(result.hits.map(hit => hit.id).sort()).toEqual(titlesWithWordHolding('skin'))
  }, 30_000)
})
