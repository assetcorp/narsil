import { existsSync } from 'node:fs'
import { afterEach, describe, expect, it } from 'vitest'
import { registerTokenizer } from '../../../analysis/registry'
import { createNarsil, type Narsil } from '../../../narsil'
import { scaledOut, waitFor } from '../../server/helpers'

const built = existsSync(new URL('../../../../dist/workers/entry.mjs', import.meta.url))
const distPackage = new URL('../../../../dist/index.mjs', import.meta.url)

const TOKENIZER = 'drop-during-worker-query'
const TERM = 'lamp'
const WORKER_STALL_MS = 1_000
const DROP_DELAY_MS = 200

function wordsOf(text: string): Array<{ token: string; position: number }> {
  return text
    .toLowerCase()
    .split(/\s+/)
    .filter(word => word.length > 0)
    .map((token, position) => ({ token, position }))
}

function bootstrapModule(): string {
  const source = `import { registerTokenizer } from ${JSON.stringify(distPackage.href)}
const parked = new Int32Array(new SharedArrayBuffer(4))
registerTokenizer(${JSON.stringify(TOKENIZER)}, {
  tokenize(text) {
    if (text === ${JSON.stringify(TERM)}) Atomics.wait(parked, 0, 0, ${WORKER_STALL_MS})
    return text.toLowerCase().split(/\\s+/).filter(word => word.length > 0).map((token, position) => ({ token, position }))
  },
})`
  return `data:text/javascript,${encodeURIComponent(source)}`
}

const DOCUMENTS = Array.from({ length: 300 }, (_, n) => ({
  id: `item-${n}`,
  title: n % 3 === 0 ? `desk ${TERM} ${n}` : `oak table ${n}`,
}))
const TERM_HITS = DOCUMENTS.filter(document => document.title.split(' ').includes(TERM))
  .map(document => document.id)
  .sort()

const engines: Narsil[] = []

afterEach(async () => {
  for (const engine of engines.splice(0)) await engine.shutdown().catch(() => undefined)
})

describe.skipIf(!built)('a drop that starts while a worker answers a query', () => {
  it('waits for the query, which returns every match, before it deletes the index', async () => {
    registerTokenizer(TOKENIZER, { tokenize: wordsOf })
    const engine = await createNarsil({
      workers: {
        enabled: true,
        count: 1,
        promotionThreshold: 2,
        mainCopyQueries: 'none',
        bootstrapModule: bootstrapModule(),
      },
    })
    engines.push(engine)
    await engine.createIndex('products', { schema: { title: 'string' }, tokenizer: TOKENIZER })
    await engine.insertBatch('products', DOCUMENTS)
    await waitFor(() => scaledOut(engine, 'products'))

    const settled: string[] = []
    const asked = performance.now()
    const query = engine.query('products', { term: TERM, limit: 1_000 }).then(result => {
      settled.push('query')
      return result
    })
    await new Promise(resolve => setTimeout(resolve, DROP_DELAY_MS))
    settled.push('drop started')
    const drop = engine.dropIndex('products').then(() => {
      settled.push('drop')
    })

    const result = await query
    const answered = performance.now()
    await drop

    expect(answered - asked).toBeGreaterThanOrEqual(WORKER_STALL_MS - 50)
    expect(settled).toEqual(['drop started', 'query', 'drop'])
    expect(result.count).toBe(TERM_HITS.length)
    expect(result.hits.map(hit => hit.id).sort()).toEqual(TERM_HITS)
    for (const hit of result.hits) {
      expect(hit.document).toEqual(DOCUMENTS.find(document => document.id === hit.id))
    }
    expect(engine.listIndexes()).toEqual([])
  }, 30_000)
})
