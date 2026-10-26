import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Narsil } from '../../../narsil'
import { type NativeOperation, observeFallbacks, setNativeSearchCoreEnabled } from '../../../vector/native/backend'
import {
  backends,
  expectNearest,
  large,
  openPapers,
  openPapersWithoutTheRing,
  recallAgainst,
  reembed,
  removeChanged,
  ringRecall,
  SETTLE_DEADLINE_MS,
  searchWithTheHostBinary,
  small,
  untilGraphSettled,
} from './fixtures'

const LIVE_RING_RECALL_FLOOR = 0.9
const REMOVED_BEFORE_THE_REBUILD = 300
const REBUILT_RECALL_FLOOR = 0.95

async function untilRebuilding(narsil: Narsil): Promise<void> {
  const deadline = Date.now() + SETTLE_DEADLINE_MS
  while (!narsil.vectorMaintenanceStatus('papers').some(field => field.building)) {
    if (Date.now() > deadline) throw new Error('optimizeVectors never started rebuilding the graph of papers')
    await new Promise(resolve => setTimeout(resolve, 0))
  }
  await new Promise(resolve => setTimeout(resolve, 0))
}

searchWithTheHostBinary()

describe.each(backends)('a vector search past tombstones through $name', ({ native, available }) => {
  let narsil: Narsil | null = null
  const fallbacks: NativeOperation[] = []

  beforeEach(() => {
    setNativeSearchCoreEnabled(native)
    fallbacks.length = 0
    observeFallbacks(operation => fallbacks.push(operation))
  })

  afterEach(async () => {
    observeFallbacks(null)
    await narsil?.shutdown()
    narsil = null
    setNativeSearchCoreEnabled(true)
  })

  it.skipIf(!available)('returns the nearest live vectors after most vectors are removed', async () => {
    const opened = await openPapers({ workers: { enabled: false } }, small.documents)
    narsil = opened
    await removeChanged(opened, small)
    await expectNearest(opened, small.kept)
    expect(fallbacks.includes('search')).toBe(!native)
    expect(opened.vectorMaintenanceStatus('papers')[0].tombstoneRatio).toBeGreaterThan(0.8)
  })

  it.skipIf(!available)('returns the nearest vectors after most documents are re-embedded far away', async () => {
    const opened = await openPapers({ workers: { enabled: false } }, small.documents)
    narsil = opened
    await reembed(opened, small)
    await expectNearest(opened, [...small.kept, ...small.reembedded])
    expect(fallbacks.includes('search')).toBe(!native)
    expect(opened.vectorMaintenanceStatus('papers')[0].tombstoneRatio).toBeGreaterThan(0)
    await opened.compactVectors('papers', 'embedding')
    expect(opened.vectorMaintenanceStatus('papers')[0].tombstoneRatio).toBe(0)
  })

  it.skipIf(!available)(
    'returns the nearest vectors when documents are re-embedded and compacted while optimizeVectors rebuilds the graph',
    async () => {
      const opened = await openPapers({ workers: { enabled: false } }, large.documents)
      narsil = opened
      const removedFirst = large.changed.slice(0, REMOVED_BEFORE_THE_REBUILD)
      const removal = await opened.removeBatch(
        'papers',
        removedFirst.map(document => document.id),
      )
      expect(removal.failed).toEqual([])
      const rebuilding = opened.optimizeVectors('papers', 'embedding')
      await untilRebuilding(opened)
      const reembedded = large.changed.slice(REMOVED_BEFORE_THE_REBUILD).map(document => ({
        id: document.id,
        embedding: document.embedding.map(value => -value),
      }))
      const update = await opened.updateBatch(
        'papers',
        reembedded.map(document => ({ docId: document.id, document })),
      )
      expect(update.failed).toEqual([])
      await opened.compactVectors('papers', 'embedding')
      await rebuilding
      await untilGraphSettled(opened)
      expect(await recallAgainst(opened, [...large.kept, ...reembedded])).toBeGreaterThanOrEqual(REBUILT_RECALL_FLOOR)
    },
  )

  it.skipIf(!available)("keeps its recall once the ring beyond each query's nearest ten is removed", async () => {
    const opened = await openPapersWithoutTheRing({ workers: { enabled: false } })
    narsil = opened
    expect(await ringRecall(opened)).toBeGreaterThanOrEqual(LIVE_RING_RECALL_FLOOR)
    expect(fallbacks.includes('search')).toBe(!native)
  })
})
