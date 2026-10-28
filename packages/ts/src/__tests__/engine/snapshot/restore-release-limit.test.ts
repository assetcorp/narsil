import { existsSync } from 'node:fs'
import { afterEach, describe, expect, it } from 'vitest'
import { registerTokenizer } from '../../../analysis/registry'
import { createNarsil, type Narsil } from '../../../narsil'
import { scaledOut, waitFor } from '../../server/helpers'
import { archiveBytes } from './restore-fixtures'

const built = existsSync(new URL('../../../../dist/workers/entry.mjs', import.meta.url))
const distPackage = new URL('../../../../dist/index.mjs', import.meta.url)

const TOKENIZER = 'restore-release-stall'
const STALL_WORD = 'stallword'
const WORKER_STALL_MS = 38_000
const RELEASE_LIMIT_MS = 30_000
const QUERY_LATENCY_LIMIT_MS = 1_000
const TERM = 'lantern'
const LIVE = 'live'
const SOURCE = 'source'

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
    if (text.includes(${JSON.stringify(STALL_WORD)})) Atomics.wait(parked, 0, 0, ${WORKER_STALL_MS})
    return text.toLowerCase().split(/\\s+/).filter(word => word.length > 0).map((token, position) => ({ token, position }))
  },
})`
  return `data:text/javascript,${encodeURIComponent(source)}`
}

const OLD_DOCUMENTS = Array.from({ length: 300 }, (_, n) => ({
  id: `old-${n}`,
  body: n % 3 === 0 ? `the ${TERM} by quay ${n}` : `the ferry by quay ${n}`,
}))
const OLD_TERM_HITS = OLD_DOCUMENTS.filter(document => document.body.includes(TERM))
  .map(document => document.id)
  .sort()
const NEW_DOCUMENTS = Array.from({ length: 200 }, (_, n) => ({ id: `new-${n}`, body: `the ${TERM} by pier ${n}` }))
const NEW_TERM_HITS = NEW_DOCUMENTS.map(document => document.id).sort()

const engines: Narsil[] = []

afterEach(async () => {
  for (const engine of engines.splice(0)) await engine.shutdown().catch(() => undefined)
})

async function termHits(engine: Narsil): Promise<string[]> {
  return (await engine.query(LIVE, { term: TERM, limit: 1_000 })).hits.map(hit => hit.id).sort()
}

describe.skipIf(!built)('a restore over an index that a worker holds busy', () => {
  it('answers from the main copy while it waits, then gives up after the release limit and keeps the old index', async () => {
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
    await engine.createIndex(LIVE, { schema: { body: 'string' }, tokenizer: TOKENIZER })
    await engine.insertBatch(LIVE, OLD_DOCUMENTS)
    await engine.createIndex(SOURCE, { schema: { body: 'string' } })
    await engine.insertBatch(SOURCE, NEW_DOCUMENTS)
    const archive = await archiveBytes(engine, SOURCE)
    await waitFor(() => scaledOut(engine, LIVE))
    expect(await termHits(engine)).toEqual(OLD_TERM_HITS)

    await engine.insert(LIVE, { body: `the ${STALL_WORD} by quay` }, 'stalled')
    const started = performance.now()
    const restored = engine.restore(LIVE, archive)
    const settled = restored.then(
      () => performance.now(),
      () => performance.now(),
    )
    await new Promise(resolve => setTimeout(resolve, 1_000))

    const asked = performance.now()
    const duringStall = await termHits(engine)
    const answered = performance.now()
    expect(duringStall).toEqual(OLD_TERM_HITS)
    expect(answered - asked).toBeLessThan(QUERY_LATENCY_LIMIT_MS)
    expect(answered).toBeLessThan(await settled)
    expect(await engine.get(LIVE, 'old-3')).toMatchObject({ body: `the ${TERM} by quay 3` })

    await expect(restored).rejects.toMatchObject({
      code: 'WORKER_TIMEOUT',
      details: { indexName: LIVE, timeoutMs: RELEASE_LIMIT_MS },
    })
    const elapsed = performance.now() - started
    expect(elapsed).toBeGreaterThanOrEqual(RELEASE_LIMIT_MS - 100)
    expect(elapsed).toBeLessThan(WORKER_STALL_MS)

    expect(await engine.get(LIVE, 'stalled')).toMatchObject({ body: `the ${STALL_WORD} by quay` })
    expect(await engine.get(LIVE, 'new-0')).toBeUndefined()
    expect(await engine.countDocuments(LIVE)).toBe(OLD_DOCUMENTS.length + 1)

    const secondRestore = engine.restore(LIVE, archive)
    const whileStuck = await termHits(engine)
    expect([OLD_TERM_HITS, NEW_TERM_HITS]).toContainEqual(whileStuck)
    await secondRestore
    expect(await termHits(engine)).toEqual(NEW_TERM_HITS)
    expect(await engine.get(LIVE, 'stalled')).toBeUndefined()

    await waitFor(() => scaledOut(engine, LIVE), 15_000)
    expect(await termHits(engine)).toEqual(NEW_TERM_HITS)
    expect(await engine.get(LIVE, 'old-3')).toBeUndefined()
  }, 60_000)
})
