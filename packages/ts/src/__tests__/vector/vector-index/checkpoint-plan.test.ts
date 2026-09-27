import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createVectorIndex,
  type VectorFilePayload,
  type VectorGraphPayload,
  type VectorIndex,
} from '../../../vector/vector-index'
import { bytesToVectors } from '../../../vector/vector-index/payload'
import { DIM, normalizedVector } from './fixtures'

interface ListedFile {
  id: number
  key: string
  count: number
  dead: Uint8Array | null
  payload: VectorFilePayload
}

interface Checkpoint {
  files: ListedFile[]
  graph: VectorGraphPayload | null
  wrote: string[]
}

function createWriter(index: VectorIndex) {
  let listed: ListedFile[] | null = null
  let graph: VectorGraphPayload | null = null
  let nextId = 0

  return {
    checkpoint(): Checkpoint {
      const plan = index.planCheckpoint(listed === null ? null : listed.map(file => file.key))
      if (plan.unchanged && listed !== null) return { files: listed, graph, wrote: [] }
      const held = listed ?? []
      const files: ListedFile[] = plan.kept.map(kept => {
        const before = held.find(file => file.key === kept.key)
        if (before === undefined) throw new Error(`the plan keeps ${kept.key}, which no checkpoint wrote`)
        return { ...before, dead: kept.dead }
      })
      const written = []
      for (let i = 0; i < plan.newFiles; i++) {
        const { payload, ordinals } = plan.readNewFile(i)
        const file = { id: nextId, key: `file-${nextId}`, count: payload.docIds.length, dead: null, payload }
        nextId += 1
        files.push(file)
        written.push({ id: file.id, key: file.key, ordinals })
      }
      index.recordCheckpoint(plan, written)
      listed = files
      graph = plan.graph
      return { files, graph, wrote: written.map(file => file.key) }
    },
  }
}

function restoreInto(target: VectorIndex, checkpoint: Checkpoint): void {
  let liveVectors = 0
  for (const file of checkpoint.files) {
    for (let i = 0; i < file.count; i++) {
      if (file.dead === null || ((file.dead[i >> 3] >> (i & 7)) & 1) === 0) liveVectors += 1
    }
  }
  const restore = target.restoreCheckpoint({ liveVectors, holdsGraph: checkpoint.graph !== null })
  for (const file of checkpoint.files) restore.addFile({ ...file, location: null })
  restore.finish(checkpoint.graph)
}

function deadPositions(file: ListedFile): number[] {
  const positions: number[] = []
  for (let i = 0; i < file.count; i++) {
    if (file.dead !== null && ((file.dead[i >> 3] >> (i & 7)) & 1) === 1) positions.push(i)
  }
  return positions
}

async function buildGraph(index: VectorIndex): Promise<void> {
  index.scheduleBuild()
  await vi.advanceTimersByTimeAsync(1)
  await index.awaitPendingBuild()
}

describe('the vector files a checkpoint plans for a field', () => {
  let index: VectorIndex

  beforeEach(() => {
    vi.useFakeTimers()
    index = createVectorIndex('embedding', DIM, { threshold: 5, quantization: 'none' }, { enabled: false })
  })

  afterEach(() => {
    index.dispose()
    vi.useRealTimers()
  })

  function insertRange(from: number, to: number): void {
    for (let i = from; i < to; i++) index.insert(`doc${i}`, normalizedVector(DIM, i + 1))
  }

  it('writes every vector once, and nothing at all while the field stays as it was', () => {
    insertRange(0, 10)
    const writer = createWriter(index)

    const first = writer.checkpoint()
    const second = writer.checkpoint()

    expect(first.wrote).toEqual(['file-0'])
    expect(first.files[0].payload.docIds).toEqual(Array.from({ length: 10 }, (_, i) => `doc${i}`))
    expect([...bytesToVectors(first.files[0].payload.vectors).subarray(DIM, 2 * DIM)]).toEqual([
      ...normalizedVector(DIM, 2),
    ])
    expect(second.wrote).toEqual([])
    expect(second.files).toBe(first.files)
  })

  it('leaves a larger file alone and writes the vectors that arrived after it into a new file', () => {
    insertRange(0, 10)
    const writer = createWriter(index)
    writer.checkpoint()
    insertRange(10, 13)

    const next = writer.checkpoint()

    expect(next.wrote).toEqual(['file-1'])
    expect(next.files.map(file => file.key)).toEqual(['file-0', 'file-1'])
    expect(next.files[1].payload.docIds).toEqual(['doc10', 'doc11', 'doc12'])
  })

  it('folds every partial file no larger than the vectors it writes into the new file', () => {
    insertRange(0, 10)
    const writer = createWriter(index)
    writer.checkpoint()
    insertRange(10, 13)
    writer.checkpoint()
    insertRange(13, 33)

    const next = writer.checkpoint()

    expect(next.files.map(file => file.key)).toEqual(['file-2'])
    expect(next.files[0].count).toBe(33)
  })

  it('marks a removed vector and a replaced vector dead in the file that holds them', () => {
    insertRange(0, 20)
    const writer = createWriter(index)
    writer.checkpoint()
    index.remove('doc3')
    index.insert('doc7', normalizedVector(DIM, 700))

    const next = writer.checkpoint()

    expect(deadPositions(next.files[0])).toEqual([3, 7])
    expect(next.files[1].payload.docIds).toEqual(['doc7'])
    expect([...bytesToVectors(next.files[1].payload.vectors)]).toEqual([...normalizedVector(DIM, 700)])
  })

  it('replaces a file once more than a fifth of its vectors are dead', () => {
    insertRange(0, 20)
    const writer = createWriter(index)
    writer.checkpoint()
    for (let i = 0; i < 5; i++) index.remove(`doc${i}`)

    const next = writer.checkpoint()

    expect(next.files.map(file => file.key)).toEqual(['file-1'])
    expect(next.files[0].payload.docIds).toEqual(Array.from({ length: 15 }, (_, i) => `doc${i + 5}`))
    expect(next.files[0].dead).toBeNull()
  })

  it('keeps a vector that arrives again unchanged in the file that already holds it', () => {
    insertRange(0, 10)
    const writer = createWriter(index)
    writer.checkpoint()
    index.insert('doc4', normalizedVector(DIM, 5))

    expect(writer.checkpoint().wrote).toEqual([])
  })

  it('writes every vector again when the manifest lists other files than the field recorded', () => {
    insertRange(0, 10)
    createWriter(index).checkpoint()

    const plan = index.planCheckpoint(['a-file-the-field-never-wrote'])

    expect(plan.kept).toEqual([])
    expect(plan.readNewFile(0).payload.docIds).toHaveLength(10)
  })

  it('reads zeros, and records no ordinal, for a vector removed between the plan and the read', () => {
    insertRange(0, 3)
    const plan = index.planCheckpoint(null)
    index.remove('doc1')
    index.compact()

    const file = plan.readNewFile(0)

    expect(file.payload.docIds).toEqual(['doc0', 'doc1', 'doc2'])
    expect([...bytesToVectors(file.payload.vectors).subarray(DIM, 2 * DIM)]).toEqual(new Array(DIM).fill(0))
    expect([...file.ordinals]).toEqual([0, -1, 2])
  })

  it('restores the vectors, the dead marks, and the graph into a field that answers the same search', async () => {
    insertRange(0, 40)
    await buildGraph(index)
    const writer = createWriter(index)
    writer.checkpoint()
    index.remove('doc2')
    insertRange(40, 60)
    await index.completeGraph()
    const checkpoint = writer.checkpoint()
    const query = normalizedVector(DIM, 21)
    const expected = index.search(query, 5, { metric: 'cosine', minSimilarity: 0 }).results.map(hit => hit.docId)

    const restored = createVectorIndex('embedding', DIM, { threshold: 5, quantization: 'none' }, { enabled: false })
    restoreInto(restored, checkpoint)

    expect(checkpoint.graph).not.toBeNull()
    expect(restored.size).toBe(59)
    expect(restored.has('doc2')).toBe(false)
    expect(restored.maintenanceStatus()).toMatchObject({ graphCount: 1, bufferSize: 0 })
    expect(restored.search(query, 5, { metric: 'cosine', minSimilarity: 0 }).results.map(hit => hit.docId)).toEqual(
      expected,
    )
    restored.dispose()
  })

  it('writes nothing after a restore until the field changes', async () => {
    insertRange(0, 40)
    await buildGraph(index)
    const checkpoint = createWriter(index).checkpoint()
    const restored = createVectorIndex('embedding', DIM, { threshold: 5, quantization: 'none' }, { enabled: false })
    restoreInto(restored, checkpoint)
    const listedKeys = checkpoint.files.map(file => file.key)

    expect(restored.planCheckpoint(listedKeys).unchanged).toBe(true)
    restored.insert('doc99', normalizedVector(DIM, 100))
    const plan = restored.planCheckpoint(listedKeys)

    expect(plan.unchanged).toBe(false)
    expect(plan.kept.map(file => file.key)).toEqual(listedKeys)
    expect(plan.readNewFile(0).payload.docIds).toEqual(['doc99'])
    restored.dispose()
  })
})

describe('the codes a checkpoint plans for a quantised field', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('restores the codes it wrote, and replaces every file once the field recalibrates', async () => {
    const coded = createVectorIndex('embedding', DIM, { threshold: 5, quantization: 'osq8' }, { enabled: false })
    for (let i = 0; i < 12; i++) coded.insert(`doc${i}`, normalizedVector(DIM, i + 1))
    await buildGraph(coded)
    const writer = createWriter(coded)
    const first = writer.checkpoint()
    expect(first.files[0].payload.codes).not.toBeNull()

    const restored = createVectorIndex('embedding', DIM, { threshold: 5, quantization: 'osq8' }, { enabled: false })
    restoreInto(restored, first)
    const listedKeys = first.files.map(file => file.key)
    expect(restored.planCheckpoint(listedKeys).unchanged).toBe(true)
    restored.dispose()

    const stalePlan = coded.planCheckpoint(listedKeys)
    for (let i = 0; i < 9; i++) coded.remove(`doc${i}`)
    for (let i = 12; i < 40; i++) coded.insert(`doc${i}`, normalizedVector(DIM, 3 * i + 5))
    await coded.optimize()

    const next = writer.checkpoint()

    expect(stalePlan.unchanged).toBe(true)
    expect(next.files.map(file => file.key)).not.toContain('file-0')
    coded.dispose()
  })

  it('refuses to read a file once the field has been recalibrated since the plan', async () => {
    const coded = createVectorIndex('embedding', DIM, { threshold: 5, quantization: 'osq8' }, { enabled: false })
    for (let i = 0; i < 12; i++) coded.insert(`doc${i}`, normalizedVector(DIM, i + 1))
    await buildGraph(coded)
    const plan = coded.planCheckpoint(null)
    for (let i = 0; i < 9; i++) coded.remove(`doc${i}`)
    for (let i = 12; i < 40; i++) coded.insert(`doc${i}`, normalizedVector(DIM, 3 * i + 5))

    await coded.optimize()

    expect(() => plan.readNewFile(0)).toThrow(/recalibrated/)
    coded.dispose()
  })
})
