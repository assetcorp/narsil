import { afterEach, expect, it } from 'vitest'
import { createNarsil, type Narsil } from '../../narsil'

const engines: Narsil[] = []

afterEach(async () => {
  for (const engine of engines.splice(0)) await engine.shutdown()
})

it('releases retrieval for a re-entrant reranker while retaining its search state', async () => {
  const engine = await createNarsil({ workers: { enabled: false } })
  engines.push(engine)
  await engine.createIndex('readings', { schema: { title: 'string' } })
  await engine.insert('readings', { title: 'river' }, 'reading')
  let calls = 0
  engine.registerRerankAdapter('reentrant', {
    async rerank(_query, texts) {
      calls++
      expect(texts).toEqual(['river'])
      expect((await engine.query('readings', { term: 'river' })).count).toBe(1)
      await engine.update('readings', 'reading', { title: 'lake' })
      expect((await engine.query('readings', { term: 'lake' })).count).toBe(1)
      expect(engine.getStats('readings').heldSearchStates).toBe(1)
      return texts.map(() => 1)
    },
  })
  const answer = await engine.query('readings', {
    term: 'river',
    rerank: { adapter: 'reentrant', fields: ['title'] },
    highlight: { fields: ['title'] },
  })
  expect(calls).toBe(1)
  expect(answer.hits.map(hit => hit.document.title)).toEqual(['river'])
  expect(answer.hits[0].highlights?.title.positions).toEqual([{ start: 0, end: 5 }])
  expect(engine.getStats('readings').heldSearchStates).toBe(0)
  await engine.update('readings', 'reading', { title: 'forest' })
  expect((await engine.query('readings', { term: 'forest' })).count).toBe(1)
}, 10_000)

it.each(['failure', 'cancellation'] as const)('releases a search pin after reranker %s', async outcome => {
  const engine = await createNarsil({ workers: { enabled: false }, rerankTimeout: 30 })
  engines.push(engine)
  await engine.createIndex('readings', { schema: { title: 'string' } })
  await engine.insert('readings', { title: 'river' }, 'reading')
  let cancelled: AbortSignal | undefined
  engine.registerRerankAdapter('unavailable', {
    async rerank(_query, _texts, signal) {
      cancelled = signal
      await engine.update('readings', 'reading', { title: 'lake' })
      if (outcome === 'failure') throw new Error('The scoring service failed')
      return new Promise<number[]>(() => undefined)
    },
  })
  await expect(
    engine.query('readings', {
      term: 'river',
      rerank: { adapter: 'unavailable', fields: ['title'] },
    }),
  ).rejects.toMatchObject({ code: 'RERANK_FAILED' })
  if (outcome === 'cancellation') expect(cancelled?.aborted).toBe(true)
  expect(engine.getStats('readings').heldSearchStates).toBe(0)
  await engine.update('readings', 'reading', { title: 'forest' })
  expect((await engine.query('readings', { term: 'forest' })).count).toBe(1)
}, 10_000)

it('permits write hooks to query and publish another document in the same index', async () => {
  let engine: Narsil | undefined
  const seen: number[] = []
  engine = await createNarsil({
    workers: { enabled: false },
    plugins: [
      {
        name: 'querying-hook',
        async beforeInsert(context) {
          if (context.docId !== 'outer' || engine === undefined) return
          seen.push((await engine.query('readings', { term: 'river' })).count)
          await engine.insert('readings', { title: 'river' }, 'inner')
        },
        async afterInsert(context) {
          if (context.docId !== 'outer' || engine === undefined) return
          seen.push((await engine.query('readings', { term: 'river' })).count)
          await engine.update('readings', 'inner', { title: 'lake' })
        },
      },
    ],
  })
  engines.push(engine)
  await engine.createIndex('readings', { schema: { title: 'string' } })
  await engine.insert('readings', { title: 'river' }, 'outer')
  expect(seen).toEqual([0, 2])
  expect((await engine.query('readings', { term: 'river' })).hits.map(hit => hit.id)).toEqual(['outer'])
  expect((await engine.query('readings', { term: 'lake' })).hits.map(hit => hit.id)).toEqual(['inner'])
  expect(engine.getStats('readings').heldSearchStates).toBe(0)
}, 10_000)
