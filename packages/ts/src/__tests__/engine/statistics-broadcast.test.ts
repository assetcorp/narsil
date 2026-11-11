import { afterEach, describe, expect, it } from 'vitest'
import { createNarsil, type Narsil } from '../../narsil'
import { createMemoryPersistence } from '../../persistence/memory'
import type { InvalidationAdapter, InvalidationEvent, PartitionStatistics } from '../../types/adapters'

const STATISTICS_WAIT_MS = 15_000
const STATISTICS_POLL_MS = 25
const INDEX = 'notes'

interface CapturingInvalidation extends InvalidationAdapter {
  readonly published: PartitionStatistics[]
  emit(event: InvalidationEvent): void
}

function capturingInvalidation(): CapturingInvalidation {
  const published: PartitionStatistics[] = []
  let handler: ((event: InvalidationEvent) => void) | null = null
  return {
    published,
    async publish(event) {
      if (event.type === 'statistics' && event.indexName === INDEX) published.push(event.stats)
    },
    async subscribe(next) {
      handler = next
    },
    async shutdown() {
      handler = null
    },
    emit(event) {
      handler?.(event)
    },
  }
}

async function statisticsAt(invalidation: CapturingInvalidation, position: number): Promise<PartitionStatistics> {
  const deadline = Date.now() + STATISTICS_WAIT_MS
  while (invalidation.published.length <= position) {
    if (Date.now() > deadline) throw new Error(`no statistics event arrived at position ${position}`)
    await new Promise(resolve => setTimeout(resolve, STATISTICS_POLL_MS))
  }
  const event = invalidation.published[position]
  if (event === undefined) throw new Error(`no statistics event at position ${position}`)
  return event
}

function documentsPerWord(titles: Iterable<string>): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const title of titles) {
    for (const word of new Set(title.split(' '))) counts[word] = (counts[word] ?? 0) + 1
  }
  return counts
}

function bm25Idf(documents: number, containing: number): number {
  return Math.log((documents - containing + 0.5) / (containing + 0.5) + 1)
}

const engines: Narsil[] = []

afterEach(async () => {
  for (const engine of engines.splice(0)) await engine.shutdown()
})

async function broadcastEngine(invalidation: CapturingInvalidation): Promise<Narsil> {
  const engine = await createNarsil({
    persistence: createMemoryPersistence(),
    invalidation,
    workers: { enabled: false },
  })
  engines.push(engine)
  await engine.createIndex(INDEX, { schema: { title: 'string' }, language: 'english', defaultScoring: 'broadcast' })
  return engine
}

describe('the statistics that an instance publishes for broadcast scoring', () => {
  it('resends one message while the index is unchanged and sends fresh counts after a remove, an update, and an insert', async () => {
    const invalidation = capturingInvalidation()
    const engine = await broadcastEngine(invalidation)
    const titles = new Map<string, string>([
      ['a', 'zork quib'],
      ['b', 'zork flarn'],
      ['c', 'gnab quib zork'],
    ])
    for (const [docId, title] of titles) await engine.insert(INDEX, { title }, docId)
    const bytesBeforeMessage = engine.getStats(INDEX).estimatedMemoryBytes
    const firstPosition = invalidation.published.length

    const first = await statisticsAt(invalidation, firstPosition)
    expect(first.totalDocs).toBe(3)
    expect({ ...first.docFrequencies }).toEqual(documentsPerWord(titles.values()))
    expect(engine.getStats(INDEX).estimatedMemoryBytes).toBeGreaterThan(bytesBeforeMessage)

    const resent = await statisticsAt(invalidation, firstPosition + 1)
    expect(resent.docFrequencies).toBe(first.docFrequencies)
    expect(resent.totalDocs).toBe(3)

    await engine.remove(INDEX, 'b')
    titles.delete('b')
    await engine.update(INDEX, 'c', { title: 'gnab gnab vex' })
    titles.set('c', 'gnab gnab vex')
    await engine.insert(INDEX, { title: 'quib' }, 'd')
    titles.set('d', 'quib')
    const changedPosition = invalidation.published.length

    const changed = await statisticsAt(invalidation, changedPosition)
    expect(changed.docFrequencies).not.toBe(first.docFrequencies)
    expect(changed.totalDocs).toBe(3)
    expect({ ...changed.docFrequencies }).toEqual(documentsPerWord(titles.values()))
  }, 60_000)

  it("scores a broadcast query against its own counts plus another instance's counts for the query's terms", async () => {
    const invalidation = capturingInvalidation()
    const engine = await broadcastEngine(invalidation)
    const titles = ['zork quib', 'zork flarn', 'gnab quib']
    for (const title of titles) await engine.insert(INDEX, { title })
    invalidation.emit({
      type: 'statistics',
      indexName: INDEX,
      instanceId: 'another-instance',
      stats: { totalDocs: 40, docFrequencies: { zork: 7, flarn: 1, unrelated: 3 }, totalFieldLengths: { title: 200 } },
    })

    const answer = await engine.query(INDEX, { term: 'zork', scoring: 'broadcast', includeScoreComponents: true })
    expect(answer.hits).toHaveLength(2)
    const ownZork = documentsPerWord(titles).zork ?? 0
    for (const hit of answer.hits) {
      expect(hit.scoreComponents?.idf.zork).toBeCloseTo(bm25Idf(titles.length + 40, ownZork + 7), 12)
    }
  }, 30_000)
})
