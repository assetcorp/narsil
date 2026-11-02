import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { decode } from '@msgpack/msgpack'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createNarsil } from '../../../narsil'
import type { Narsil } from '../../../types/engine'
import { requireManifestOnDisk } from '../../persistence/durability/manifest-on-disk'
import { seededRandom } from './oracle'

const INDEX = 'passages'
const DIMENSION = 48
const PASSAGES = 3_000
const REPLACED_EACH_ROUND = 200
const ADDED_EACH_ROUND = 100
const ENVELOPE_HEADER_BYTES = 32
const FLOAT32_BYTES = 4
const FLOAT64_BYTES = 8
const MAGNITUDE_TOLERANCE = 1e-5
const LOAD_POLL_MS = 10

interface WrittenSection {
  name: string
  offset: number
  length: number
}

describe('the magnitudes section of a written vector file', () => {
  let root = ''
  let engine: Narsil
  const written = new Map<string, Float32Array[]>()
  const random = seededRandom(195)

  function open(): Promise<Narsil> {
    return createNarsil({ durability: { directory: root }, workers: { enabled: false } })
  }

  function freshVector(docId: string): number[] {
    const values = Array.from({ length: DIMENSION }, () => random() * 2 - 1)
    written.set(docId, [...(written.get(docId) ?? []), Float32Array.from(values)])
    return values
  }

  async function replaceAndAdd(round: number): Promise<void> {
    for (let at = 0; at < REPLACED_EACH_ROUND; at++) {
      const docId = `passage-${(at * 7 + round * 11) % PASSAGES}`
      await engine.update(INDEX, docId, { title: `replaced in round ${round}`, embedding: freshVector(docId) })
    }
    for (let at = 0; at < ADDED_EACH_ROUND; at++) {
      const docId = `added-${round}-${at}`
      await engine.insert(INDEX, { title: `added in round ${round}`, embedding: freshVector(docId) }, docId)
    }
  }

  function storedVector(bytes: Buffer, start: number, position: number): Float32Array {
    const vector = new Float32Array(DIMENSION)
    for (let at = 0; at < DIMENSION; at++) {
      vector[at] = bytes.readFloatLE(start + (position * DIMENSION + at) * FLOAT32_BYTES)
    }
    return vector
  }

  function lengthOf(vector: Float32Array): number {
    let squared = 0
    for (const value of vector) squared += value * value
    return Math.sqrt(squared)
  }

  async function expectEveryFileHoldsTheLengthOfItsVectors(): Promise<number> {
    const manifest = await requireManifestOnDisk(root, INDEX)
    const files = manifest.vectors.flatMap(field => field.files)
    expect(files.length).toBeGreaterThan(0)
    let compared = 0
    for (const file of files) {
      const { headOffset, headLength } = file
      if (headOffset === undefined || headLength === undefined) throw new Error(`${file.key} holds no head`)
      const bytes = await readFile(join(root, file.key))
      const headAt = ENVELOPE_HEADER_BYTES + headOffset
      const head = decode(bytes.subarray(headAt, headAt + headLength)) as { sections: WrittenSection[] }
      const sectionNamed = (name: string): WrittenSection => {
        const section = head.sections.find(candidate => candidate.name === name)
        if (section === undefined) throw new Error(`${file.key} lists no ${name} section`)
        return section
      }
      const ids = sectionNamed('docIds')
      const idsAt = ENVELOPE_HEADER_BYTES + ids.offset
      const docIds = decode(bytes.subarray(idsAt, idsAt + ids.length)) as string[]
      const magnitudes = sectionNamed('magnitudes')
      const magnitudesAt = ENVELOPE_HEADER_BYTES + magnitudes.offset
      const vectorsAt = ENVELOPE_HEADER_BYTES + sectionNamed('vectors').offset
      expect(magnitudes.length).toBe(docIds.length * FLOAT64_BYTES)
      for (let position = 0; position < docIds.length; position++) {
        const vector = storedVector(bytes, vectorsAt, position)
        const versions = written.get(docIds[position]) ?? []
        expect(versions.some(version => version.every((value, at) => value === vector[at]))).toBe(true)
        const stored = bytes.readDoubleLE(magnitudesAt + position * FLOAT64_BYTES)
        expect(Math.abs(stored - lengthOf(vector))).toBeLessThan(MAGNITUDE_TOLERANCE)
        compared += 1
      }
    }
    return compared
  }

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'narsil-vector-magnitudes-'))
    written.clear()
    engine = await open()
    await engine.createIndex(INDEX, { schema: { title: 'string', embedding: `vector[${DIMENSION}]` } })
  })

  afterEach(async () => {
    await engine.shutdown()
    await rm(root, { recursive: true, force: true })
  })

  it('holds the length of each vector after replacements, a restart with writes during the load, and a settled restart', async () => {
    const passages = Array.from({ length: PASSAGES }, (_, at) => ({
      id: `passage-${at}`,
      title: `passage ${at}`,
      embedding: freshVector(`passage-${at}`),
    }))
    await engine.insertBatch(INDEX, passages)
    await engine.checkpoint(INDEX)
    const first = await expectEveryFileHoldsTheLengthOfItsVectors()
    expect(first).toBeGreaterThanOrEqual(PASSAGES)

    await replaceAndAdd(1)
    await engine.checkpoint(INDEX)
    const afterReplacing = await expectEveryFileHoldsTheLengthOfItsVectors()
    expect(afterReplacing).toBeGreaterThan(first)

    await engine.shutdown()
    engine = await open()
    await replaceAndAdd(2)
    await engine.checkpoint(INDEX)
    const afterWritingDuringLoad = await expectEveryFileHoldsTheLengthOfItsVectors()
    expect(afterWritingDuringLoad).toBeGreaterThan(afterReplacing)

    await engine.shutdown()
    engine = await open()
    while (engine.vectorMaintenanceStatus(INDEX).some(status => status.building || status.loadingFromFiles)) {
      await new Promise(resolve => setTimeout(resolve, LOAD_POLL_MS))
    }
    await replaceAndAdd(3)
    await engine.checkpoint(INDEX)
    const afterSettledRestart = await expectEveryFileHoldsTheLengthOfItsVectors()
    expect(afterSettledRestart).toBeGreaterThan(afterWritingDuringLoad)
  }, 120_000)
})
