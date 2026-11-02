import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { decode, encode } from '@msgpack/msgpack'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createNarsil } from '../../../narsil'
import { createDurableDirectory } from '../../../persistence/durability/durable-filesystem'
import { manifestKey } from '../../../persistence/durability/segment/layout'
import { encodeSegmentManifest, type FileRef } from '../../../persistence/durability/segment/manifest'
import { directoryCheckpointStore } from '../../../persistence/durability/segment/store'
import {
  GRAPH_PART_ENVELOPE_VERSION,
  VECTOR_FILE_ENVELOPE_VERSION,
} from '../../../persistence/durability/segment/vector-load'
import { vectorPartChunks } from '../../../persistence/durability/segment/vector-part-bytes'
import { unpackEnvelopeBytes } from '../../../serialization/envelope'
import { packChecksummedEnvelope } from '../../../serialization/envelope-file'
import type { Narsil } from '../../../types/engine'
import type { IndexConfig } from '../../../types/schema'
import { decodeVectorFilePayload } from '../../../vector/vector-index/checkpoint-payload'
import { requireManifestOnDisk } from '../../persistence/durability/manifest-on-disk'
import { seededRandom } from './oracle'

const INDEX = 'passages'
const DIMENSION = 16
const PASSAGES = 800
const TOP = 10
const MIN_RECALL = 0.8
const WAIT_LIMIT_MS = 60_000
const WAIT_POLL_MS = 5

const CONFIG: IndexConfig = {
  schema: { title: 'string', embedding: `vector[${DIMENSION}]` },
  language: 'english',
  vectorPromotion: { threshold: 64, quantization: 'none' },
}

function randomVector(random: () => number): number[] {
  return Array.from({ length: DIMENSION }, () => random() * 2 - 1)
}

function cosine(left: readonly number[], right: readonly number[]): number {
  let dot = 0
  let leftSquared = 0
  let rightSquared = 0
  for (let at = 0; at < DIMENSION; at++) {
    dot += left[at] * right[at]
    leftSquared += left[at] * left[at]
    rightSquared += right[at] * right[at]
  }
  return dot / Math.sqrt(leftSquared * rightSquared)
}

function withoutHead<Ref extends FileRef>(ref: Ref, bytes: number, checksum: number): Ref {
  const { headOffset: _offset, headLength: _length, headChecksum: _checksum, ...rest } = ref
  return { ...rest, bytes, checksum } as Ref
}

async function rewriteVectorFilesWithoutHeads(root: string): Promise<void> {
  const directory = createDurableDirectory(root)
  const store = directoryCheckpointStore(directory)
  const manifest = await requireManifestOnDisk(directory, INDEX)
  const vectors = []
  for (const field of manifest.vectors) {
    const files = []
    for (const file of field.files) {
      expect(file.headOffset).toBeDefined()
      const held = await store.read(file.key)
      if (held === null) throw new Error(`the vector file "${file.key}" is missing`)
      const { payloadBytes } = await unpackEnvelopeBytes(held)
      const packed = await packChecksummedEnvelope(
        vectorPartChunks(decodeVectorFilePayload(decode(payloadBytes))),
        VECTOR_FILE_ENVELOPE_VERSION,
        `vector file "${file.key}"`,
      )
      await store.write(file.key, packed.chunks)
      files.push(withoutHead(file, packed.byteLength, packed.checksum))
    }
    const graphParts = []
    for (const part of field.graphParts) {
      const held = await store.read(part.key)
      if (held === null) throw new Error(`the graph part "${part.key}" is missing`)
      const { payloadBytes } = await unpackEnvelopeBytes(held)
      const packed = await packChecksummedEnvelope(
        [encode(decode(payloadBytes))],
        GRAPH_PART_ENVELOPE_VERSION,
        `graph part "${part.key}"`,
      )
      await store.write(part.key, packed.chunks)
      graphParts.push(withoutHead(part, packed.byteLength, packed.checksum))
    }
    vectors.push({ ...field, files, graphParts })
  }
  const packedManifest = await encodeSegmentManifest({ ...manifest, vectors })
  await store.write(manifestKey(INDEX), packedManifest.chunks)
}

describe('a vector field whose files were written without a head', () => {
  let root: string
  let engine: Narsil

  async function open(): Promise<void> {
    engine = await createNarsil({ durability: { directory: root }, workers: { enabled: false } })
  }

  function isLoading(): boolean {
    return engine.vectorMaintenanceStatus(INDEX).some(status => status.loadingFromFiles)
  }

  function isBuilding(): boolean {
    return engine.vectorMaintenanceStatus(INDEX).some(status => status.building)
  }

  async function until(busy: () => boolean, what: string): Promise<void> {
    const deadline = Date.now() + WAIT_LIMIT_MS
    while (busy()) {
      if (Date.now() > deadline) throw new Error(`The field never finished ${what}`)
      await new Promise(resolve => setTimeout(resolve, WAIT_POLL_MS))
    }
  }

  async function expectAnswersOf(oracle: ReadonlyMap<string, number[]>, random: () => number): Promise<void> {
    for (let round = 0; round < 12; round++) {
      const query = randomVector(random)
      const wanted = [...oracle]
        .map(([id, vector]) => ({ id, score: cosine(vector, query) }))
        .sort((left, right) => right.score - left.score)
        .slice(0, TOP)
        .map(entry => entry.id)
      const page = await engine.query(INDEX, { vector: { field: 'embedding', value: query }, limit: TOP })
      const found = page.hits.map(hit => hit.id)
      for (const id of found) expect(oracle.has(id), id).toBe(true)
      const shared = found.filter(id => wanted.includes(id)).length
      expect(shared / TOP).toBeGreaterThanOrEqual(MIN_RECALL)
    }
    let checked = 0
    for (const [id, vector] of oracle) {
      if (checked % 37 === 0) {
        const document = await engine.get(INDEX, id)
        expect(Array.from(document?.embedding as Float32Array)).toEqual(Array.from(Float32Array.from(vector)))
      }
      checked += 1
    }
    expect(engine.getStats(INDEX).documentCount).toBe(oracle.size)
  }

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'narsil-headless-vectors-'))
    await open()
    await engine.createIndex(INDEX, CONFIG)
  })

  afterEach(async () => {
    await engine.shutdown()
    await rm(root, { recursive: true, force: true })
  })

  it('answers from them through writes, checkpoints, a compaction, and restarts', async () => {
    const random = seededRandom(9500)
    const oracle = new Map<string, number[]>()
    for (let at = 0; at < PASSAGES; at++) {
      const embedding = randomVector(random)
      await engine.insert(INDEX, { title: `passage ${at}`, embedding }, `passage-${at}`)
      oracle.set(`passage-${at}`, embedding)
    }
    await engine.optimizeVectors(INDEX)
    await until(isBuilding, 'its graph')
    await engine.checkpoint(INDEX)
    await engine.shutdown()
    await rewriteVectorFilesWithoutHeads(root)

    await open()
    expect(isLoading()).toBe(false)
    await expectAnswersOf(oracle, random)

    for (let at = 0; at < 60; at++) {
      const embedding = randomVector(random)
      await engine.insert(INDEX, { title: `later ${at}`, embedding }, `later-${at}`)
      oracle.set(`later-${at}`, embedding)
    }
    for (let at = 0; at < 40; at++) {
      await engine.remove(INDEX, `passage-${at * 3}`)
      oracle.delete(`passage-${at * 3}`)
    }
    for (let at = 0; at < 10; at++) {
      const embedding = randomVector(random)
      await engine.update(INDEX, `passage-${at * 3 + 1}`, { title: `replaced ${at}`, embedding })
      oracle.set(`passage-${at * 3 + 1}`, embedding)
    }
    await until(isBuilding, 'its graph')
    await expectAnswersOf(oracle, random)
    await engine.checkpoint(INDEX)
    const mixed = await requireManifestOnDisk(root, INDEX)
    const heads = mixed.vectors.flatMap(field => field.files).map(file => file.headOffset !== undefined)
    expect(heads).toContain(false)

    await engine.shutdown()
    await open()
    expect(isLoading()).toBe(false)
    await expectAnswersOf(oracle, random)

    await engine.compactVectors(INDEX)
    await until(isBuilding, 'its graph')
    await engine.checkpoint(INDEX)
    await expectAnswersOf(oracle, random)

    await engine.shutdown()
    await open()
    await expectAnswersOf(oracle, random)
    await until(isLoading, 'its load')
    await expectAnswersOf(oracle, random)
  }, 120_000)
})
