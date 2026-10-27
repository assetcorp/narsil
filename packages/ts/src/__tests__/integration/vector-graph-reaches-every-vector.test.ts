import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createNarsil, type Narsil } from '../../narsil'
import { type NativeOperation, observeFallbacks, setNativeSearchCoreEnabled } from '../../vector/native/backend'
import { waitFor } from '../server/helpers'
import { backends, searchWithTheHostBinary } from './removed-vectors/fixtures'
import { snapshotWithBaseLists, snapshotWithoutLinksTo } from './saved-graph-edit'
import { type GraphWalk, walkSavedGraph } from './saved-graph-walk'

const DIMENSION = 1_536
const CLIPS = 1_200
const INSERT_BATCH = 300
const REEMBEDDED = 40
const REEMBEDDED_INTO_THE_GRAPH = 100
const PROMOTION_THRESHOLD = 100
const REEMBED_EVERY = 2
const REEMBED_SEED = 2_000_003
const REEMBED_INTO_THE_GRAPH_SEED = 3_000_017
const SETTLE_TIMEOUT_MS = 120_000
const INDEX = 'clips'
const RESTORED_INDEX = 'restored-clips'
const FIELD = 'embedding'
const CUT_NODES = 12
const CUT_EVERY = 37
const FULL_LIST = 0
const FIRST_UNLINKED = 1
const SECOND_UNLINKED = 2
const FIRST_HELD_BY_FULL_LIST = 3
const CHAIN_HEAD = 0
const CHAIN_MIDDLE = 1
const CHAIN_TAIL = 2
const ONLY_LINK_INTO_THE_CHAIN = 3
const CHAIN_ENTRY_POINT = 4
const FIRST_AFTER_CHAIN_ENTRY_POINT = 5

type Clip = {
  id: string
  title: string
  embedding: number[]
}

function seeded(seed: number, length: number): number[] {
  let state = seed >>> 0
  const values = new Array<number>(length)
  for (let i = 0; i < length; i++) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    values[i] = Math.fround(state / 2147483648 - 1)
  }
  return values
}

function missedBy(walk: GraphWalk): { unplaced: string[]; unreached: string[] } {
  return { unplaced: walk.unplaced, unreached: walk.unreached }
}

async function openSettledClips(): Promise<{ opened: Narsil; clips: Clip[] }> {
  const opened = await createNarsil({ workers: { enabled: false } })
  await opened.createIndex(INDEX, {
    schema: { title: 'string', [FIELD]: `vector[${DIMENSION}]` },
    vectorPromotion: { threshold: PROMOTION_THRESHOLD, quantization: 'osq4' },
  })
  const clips: Clip[] = Array.from({ length: CLIPS }, (_, i) => ({
    id: `clip-${i}`,
    title: `clip ${i}`,
    embedding: seeded(i + 1, DIMENSION),
  }))
  await opened.insertBatch(INDEX, clips)
  await waitFor(async () => {
    const [field] = opened.vectorMaintenanceStatus(INDEX)
    return field !== undefined && field.graphCount === 1 && field.bufferSize === 0 && !field.building
  }, SETTLE_TIMEOUT_MS)
  return { opened, clips }
}

async function compactAwayTheOnlyLinkIntoAChain(
  opened: Narsil,
  chainTailList: readonly number[] = [],
): Promise<{ saved: GraphWalk; removed: string; compacted: GraphWalk }> {
  const archive = await snapshotWithBaseLists(await opened.snapshot(INDEX), FIELD, baseListLimit => {
    const baseListOf = (number: number): number[] => {
      if (number === CHAIN_HEAD) {
        const reachedElsewhere = Array.from({ length: baseListLimit - 1 }, (_, i) => FIRST_AFTER_CHAIN_ENTRY_POINT + i)
        return [CHAIN_MIDDLE, ...reachedElsewhere]
      }
      if (number === CHAIN_MIDDLE) return [CHAIN_TAIL]
      if (number === CHAIN_TAIL) return [...chainTailList]
      if (number === ONLY_LINK_INTO_THE_CHAIN) return [CHAIN_HEAD]
      if (number === CHAIN_ENTRY_POINT) return [FIRST_AFTER_CHAIN_ENTRY_POINT, ONLY_LINK_INTO_THE_CHAIN]
      return number === CLIPS - 1 ? [] : [number + 1]
    }
    return { entryPoint: CHAIN_ENTRY_POINT, baseListOf }
  })
  const saved = await walkSavedGraph(new Blob([archive]).stream(), INDEX, FIELD)
  const removed = saved.liveDocIds[ONLY_LINK_INTO_THE_CHAIN]
  await opened.restore(RESTORED_INDEX, archive)
  const removal = await opened.removeBatch(RESTORED_INDEX, [removed])
  expect(removal.failed).toEqual([])
  await opened.compactVectors(RESTORED_INDEX, FIELD)
  const compacted = await walkSavedGraph(await opened.snapshot(RESTORED_INDEX), RESTORED_INDEX, FIELD)
  return { saved, removed, compacted }
}

function closedGroup(members: number[], position: number): number[] {
  return Array.from({ length: members.length - 1 }, (_, i) => members[(position + 1 + i) % members.length])
}

async function compactWhileEveryReachedListIsFull(
  opened: Narsil,
): Promise<{ saved: GraphWalk; orphanGroups: string[]; compacted: GraphWalk }> {
  let sharedTarget = -1
  let removed = -1
  let orphanGroups: number[] = []
  const archive = await snapshotWithBaseLists(await opened.snapshot(INDEX), FIELD, baseListLimit => {
    const span = (from: number, length: number): number[] => Array.from({ length }, (_, i) => from + i)
    const firstOrphanGroup = [0, ...span(2, baseListLimit)]
    const secondOrphanGroup = [1, ...span(baseListLimit + 2, baseListLimit)]
    orphanGroups = [...firstOrphanGroup, ...secondOrphanGroup]
    const host = 2 * baseListLimit + 2
    sharedTarget = host + 1
    removed = host + 2
    const reachedOnlyFromHost = span(host + 3, baseListLimit - 1)
    const ring = span(3 * baseListLimit + 4, CLIPS - 3 * baseListLimit - 4)
    const ringList = (position: number): number[] =>
      Array.from({ length: baseListLimit }, (_, i) => ring[(position + 1 + i) % ring.length])
    const listOf = new Map<number, number[]>()
    firstOrphanGroup.forEach((number, position) => {
      listOf.set(number, closedGroup(firstOrphanGroup, position))
    })
    secondOrphanGroup.forEach((number, position) => {
      listOf.set(number, closedGroup(secondOrphanGroup, position))
    })
    listOf.set(0, [host, ...closedGroup(firstOrphanGroup, 0).slice(0, -1)])
    listOf.set(1, [sharedTarget, ...closedGroup(secondOrphanGroup, 0).slice(0, -1)])
    listOf.set(host, [sharedTarget, ...reachedOnlyFromHost])
    listOf.set(sharedTarget, ringList(0))
    listOf.set(removed, [])
    reachedOnlyFromHost.forEach((number, position) => {
      listOf.set(number, ringList(position))
    })
    ring.forEach((number, position) => {
      listOf.set(number, ringList(position))
    })
    listOf.set(ring[1], [...ringList(1).slice(0, -1), host])
    listOf.set(ring[2], [...ringList(2).slice(0, -1), removed])
    return { entryPoint: ring[0], baseListOf: number => listOf.get(number) ?? [] }
  })
  const saved = await walkSavedGraph(new Blob([archive]).stream(), INDEX, FIELD)
  await opened.restore(RESTORED_INDEX, archive)
  const removal = await opened.removeBatch(RESTORED_INDEX, [saved.liveDocIds[removed]])
  expect(removal.failed).toEqual([])
  await opened.compactVectors(RESTORED_INDEX, FIELD)
  const compacted = await walkSavedGraph(await opened.snapshot(RESTORED_INDEX), RESTORED_INDEX, FIELD)
  return { saved, orphanGroups: orphanGroups.map(number => saved.liveDocIds[number]), compacted }
}

searchWithTheHostBinary()

describe.each(backends)('a vector graph built from 4-bit codes through $name', ({ native, available }) => {
  let engine: Narsil | null = null
  const fallbacks: NativeOperation[] = []

  beforeEach(() => {
    setNativeSearchCoreEnabled(native)
    fallbacks.length = 0
    observeFallbacks(operation => fallbacks.push(operation))
  })

  afterEach(async () => {
    observeFallbacks(null)
    await engine?.shutdown()
    engine = null
    setNativeSearchCoreEnabled(true)
  })

  it.skipIf(!available)(
    'links every live vector to the entry point after re-embeds during builds and after compaction',
    async () => {
      const opened = await createNarsil({ workers: { enabled: false } })
      engine = opened
      await opened.createIndex(INDEX, {
        schema: { title: 'string', [FIELD]: `vector[${DIMENSION}]` },
        vectorPromotion: { threshold: PROMOTION_THRESHOLD, quantization: 'osq4' },
      })

      const clips: Clip[] = Array.from({ length: CLIPS }, (_, i) => ({
        id: `clip-${i}`,
        title: `clip ${i}`,
        embedding: seeded(i + 1, DIMENSION),
      }))
      for (let start = 0; start < CLIPS; start += INSERT_BATCH) {
        await opened.insertBatch(INDEX, clips.slice(start, start + INSERT_BATCH))
      }
      const reembed = async (position: number, seed: number): Promise<void> => {
        const reembedded = { ...clips[position], embedding: seeded(seed, DIMENSION) }
        await opened.update(INDEX, reembedded.id, reembedded)
        clips[position] = reembedded
      }
      const settled = async (): Promise<boolean> => {
        const [field] = opened.vectorMaintenanceStatus(INDEX)
        return field !== undefined && field.graphCount === 1 && field.bufferSize === 0 && !field.building
      }
      for (let step = 0; step < REEMBEDDED; step++) await reembed(step * REEMBED_EVERY, REEMBED_SEED + step)
      await waitFor(settled, SETTLE_TIMEOUT_MS)
      for (let step = 0; step < REEMBEDDED_INTO_THE_GRAPH; step++) {
        await reembed(step * REEMBED_EVERY + 1, REEMBED_INTO_THE_GRAPH_SEED + step)
      }
      await waitFor(settled, SETTLE_TIMEOUT_MS)
      const everyClip = clips.map(clip => clip.id).sort()

      const beforeCompaction = await walkSavedGraph(await opened.snapshot(INDEX), INDEX, FIELD)
      expect(opened.vectorMaintenanceStatus(INDEX)[0].tombstoneRatio).toBeGreaterThan(0)
      await opened.compactVectors(INDEX, FIELD)
      expect(opened.vectorMaintenanceStatus(INDEX)[0].tombstoneRatio).toBe(0)
      const afterCompaction = await walkSavedGraph(await opened.snapshot(INDEX), INDEX, FIELD)

      expect([...beforeCompaction.liveDocIds].sort()).toEqual(everyClip)
      expect([...afterCompaction.liveDocIds].sort()).toEqual(everyClip)
      expect(afterCompaction.graphCount).toBe(1)
      expect(afterCompaction.nodeCount).toBe(CLIPS)
      expect({ beforeCompaction: missedBy(beforeCompaction), afterCompaction: missedBy(afterCompaction) }).toEqual({
        beforeCompaction: { unplaced: [], unreached: [] },
        afterCompaction: { unplaced: [], unreached: [] },
      })
      if (native) {
        expect(fallbacks).not.toContain('place')
        expect(fallbacks).not.toContain('compact')
      }
    },
    300_000,
  )

  const openTheClips = async (): Promise<{ opened: Narsil; clips: Clip[] }> => {
    const settled = await openSettledClips()
    engine = settled.opened
    return settled
  }

  it.skipIf(!available)(
    'links every vector once it restores a saved graph that left some vectors with no incoming link',
    async () => {
      const { opened, clips } = await openTheClips()

      const { archive, cut } = await snapshotWithoutLinksTo(await opened.snapshot(INDEX), FIELD, baseNodes =>
        baseNodes.filter((_, position) => position % CUT_EVERY === 0).slice(0, CUT_NODES),
      )
      expect(cut).toHaveLength(CUT_NODES)
      const saved = await walkSavedGraph(new Blob([archive]).stream(), INDEX, FIELD)
      expect(saved.unreached.length).toBeGreaterThanOrEqual(CUT_NODES)

      await opened.restore(RESTORED_INDEX, archive)
      const restored = await walkSavedGraph(await opened.snapshot(RESTORED_INDEX), RESTORED_INDEX, FIELD)
      expect([...restored.liveDocIds].sort()).toEqual(clips.map(clip => clip.id).sort())
      expect(missedBy(restored)).toEqual({ unplaced: [], unreached: [] })
    },
    300_000,
  )

  it.skipIf(!available)(
    'links two unlinked vectors to the entry point when they come before every node with room for them',
    async () => {
      const { opened, clips } = await openTheClips()

      const archive = await snapshotWithBaseLists(await opened.snapshot(INDEX), FIELD, baseListLimit => {
        const entryPoint = FIRST_HELD_BY_FULL_LIST + baseListLimit
        const baseListOf = (number: number): number[] => {
          if (number === FULL_LIST) return Array.from({ length: baseListLimit }, (_, i) => FIRST_HELD_BY_FULL_LIST + i)
          if (number === FIRST_UNLINKED || number === SECOND_UNLINKED) return [FULL_LIST]
          if (number < entryPoint || number === CLIPS - 1) return []
          return number === entryPoint ? [number + 1, FULL_LIST] : [number + 1]
        }
        return { entryPoint, baseListOf }
      })
      const saved = await walkSavedGraph(new Blob([archive]).stream(), INDEX, FIELD)
      expect(saved.unreached).toHaveLength(2)

      await opened.restore(RESTORED_INDEX, archive)
      const restored = await walkSavedGraph(await opened.snapshot(RESTORED_INDEX), RESTORED_INDEX, FIELD)
      expect([...restored.liveDocIds].sort()).toEqual(clips.map(clip => clip.id).sort())
      expect(missedBy(restored)).toEqual({ unplaced: [], unreached: [] })
    },
    300_000,
  )

  it.skipIf(!available)(
    'links a chain of three vectors back to the entry point once compaction removes the only link into it',
    async () => {
      const { opened, clips } = await openTheClips()

      const { saved, removed, compacted } = await compactAwayTheOnlyLinkIntoAChain(opened)
      expect(saved.liveDocIds).toHaveLength(CLIPS)
      expect(missedBy(saved)).toEqual({ unplaced: [], unreached: [] })
      const remaining = clips.map(clip => clip.id).filter(id => id !== removed)
      expect([...compacted.liveDocIds].sort()).toEqual(remaining.sort())
      expect(compacted.nodeCount).toBe(CLIPS - 1)
      expect(missedBy(compacted)).toEqual({ unplaced: [], unreached: [] })
      if (native) {
        expect(fallbacks).not.toContain('compact')
        expect(fallbacks).not.toContain('connect')
      }
    },
    300_000,
  )

  it.skipIf(!available)(
    'links a cycle of three vectors back to the entry point once compaction removes the only link into it',
    async () => {
      const { opened, clips } = await openTheClips()

      const { saved, removed, compacted } = await compactAwayTheOnlyLinkIntoAChain(opened, [CHAIN_HEAD])
      expect(missedBy(saved)).toEqual({ unplaced: [], unreached: [] })
      expect(saved.baseListOf.get(saved.liveDocIds[CHAIN_TAIL])).toEqual([saved.liveDocIds[CHAIN_HEAD]])
      const remaining = clips.map(clip => clip.id).filter(id => id !== removed)
      expect([...compacted.liveDocIds].sort()).toEqual(remaining.sort())
      expect(missedBy(compacted)).toEqual({ unplaced: [], unreached: [] })
      if (native) {
        expect(fallbacks).not.toContain('compact')
        expect(fallbacks).not.toContain('connect')
      }
    },
    300_000,
  )

  it.skipIf(!available)(
    'keeps every vector reachable when the walk must take a link out of a full list to connect a closed group',
    async () => {
      const { opened } = await openTheClips()

      const { saved, orphanGroups, compacted } = await compactWhileEveryReachedListIsFull(opened)
      expect([...saved.unreached].sort()).toEqual([...orphanGroups].sort())
      expect(compacted.nodeCount).toBe(CLIPS - 1)
      expect(missedBy(compacted)).toEqual({ unplaced: [], unreached: [] })
      if (native) {
        expect(fallbacks).not.toContain('compact')
        expect(fallbacks).not.toContain('connect')
      }
    },
    300_000,
  )
})

describe('a chain that compaction cuts off', () => {
  const nativeCoreAvailable = backends.every(backend => backend.available)

  afterEach(() => {
    observeFallbacks(null)
    setNativeSearchCoreEnabled(true)
  })

  it.skipIf(!nativeCoreAvailable)(
    'gets the same base lists from the C core and the TypeScript search',
    async () => {
      const compactedThrough = async (native: boolean): Promise<GraphWalk> => {
        setNativeSearchCoreEnabled(native)
        const { opened } = await openSettledClips()
        try {
          return (await compactAwayTheOnlyLinkIntoAChain(opened)).compacted
        } finally {
          await opened.shutdown()
        }
      }
      const fallbacks: NativeOperation[] = []
      const throughTypeScript = await compactedThrough(false)
      observeFallbacks(operation => fallbacks.push(operation))
      const throughNativeCore = await compactedThrough(true)

      expect(fallbacks).toEqual([])
      expect(missedBy(throughNativeCore)).toEqual({ unplaced: [], unreached: [] })
      expect(throughNativeCore.baseListOf.size).toBe(CLIPS - 1)
      expect(throughNativeCore.baseListOf).toEqual(throughTypeScript.baseListOf)
    },
    300_000,
  )
})
