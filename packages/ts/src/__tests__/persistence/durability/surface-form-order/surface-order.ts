import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { decode } from '@msgpack/msgpack'
import { describe, expect, it } from 'vitest'
import { createNarsil } from '../../../../narsil'
import { openEnvelope } from '../../../e2e/portability/archive-oracle'
import {
  BACKEND_NAMES,
  backendAvailable,
  type SearchBackend,
  searchThrough,
} from '../../../integration/filtered-vectors/search-backend'

const INDEX = 'pantry'
const BATCHES = 3
const DOCUMENTS_PER_BATCH = 40
const TEST_TIMEOUT_MS = 120_000
const STEMS: ReadonlyArray<readonly [string, string]> = [
  ['zipping', 'zip'],
  ['éclairs', 'éclair'],
  ['walking', 'walk'],
  ['running', 'run'],
  ['kettles', 'kettl'],
  ['folding', 'fold'],
  ['books', 'book'],
  ['apples', 'appl'],
]
const STEM_OF = new Map(STEMS)
const decoder = new TextDecoder()

interface SurfaceEntry {
  surface: string
  token: string
  count: number
}

function uint32s(bytes: Uint8Array): number[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  return Array.from({ length: bytes.byteLength / 4 }, (_, at) => view.getUint32(at * 4, true))
}

function textsOf(blob: Uint8Array, offsets: readonly number[]): string[] {
  return offsets.slice(0, -1).map((start, at) => decoder.decode(blob.subarray(start, offsets[at + 1])))
}

function codePointOrder(left: string, right: string): number {
  const a = Array.from(left, character => character.codePointAt(0) ?? 0)
  const b = Array.from(right, character => character.codePointAt(0) ?? 0)
  for (let at = 0; at < Math.min(a.length, b.length); at++) if (a[at] !== b[at]) return a[at] - b[at]
  return a.length - b.length
}

function bodyAt(ordinal: number): string {
  const words = STEMS.map(([word]) => word)
  const held = words.slice(ordinal % words.length).concat(words.slice(0, 1 + (ordinal % 3)))
  return held.join(' ')
}

function expectedEntries(bodies: readonly string[]): SurfaceEntry[] {
  const counts = new Map<string, number>()
  for (const body of bodies) for (const word of body.split(' ')) counts.set(word, (counts.get(word) ?? 0) + 1)
  return [...counts]
    .map(([surface, count]) => ({ surface, token: STEM_OF.get(surface) ?? '', count }))
    .sort((left, right) => codePointOrder(left.surface, right.surface))
}

async function segmentSurfaces(root: string, key: string, bodies: ReadonlyMap<string, string>) {
  const payload = decode(openEnvelope(new Uint8Array(await readFile(join(root, key)))).payload) as Record<
    string,
    unknown
  >
  const ids = textsOf(payload.ids as Uint8Array, uint32s(payload.idOffsets as Uint8Array))
  const column = payload.surfaceForms as { text: Uint8Array; offsets: Uint8Array; counts: Uint8Array }
  const pairs = textsOf(column.text, uint32s(column.offsets))
  const stored = uint32s(column.counts).map((count, at) => ({
    surface: pairs[2 * at],
    token: pairs[2 * at + 1],
    count,
  }))
  const held = ids.map(id => bodies.get(id) ?? '')
  return { stored, expected: expectedEntries(held), documents: ids.length }
}

async function listedSegments(root: string): Promise<string[]> {
  const manifest = decode(openEnvelope(new Uint8Array(await readFile(join(root, INDEX, 'manifest')))).payload) as {
    partitions: Array<{ segments: Array<{ key: string }> }>
  }
  return manifest.partitions.flatMap(partition => partition.segments.map(segment => segment.key))
}

export function describeSurfaceFormOrder(backend: SearchBackend): void {
  describe.skipIf(!backendAvailable(backend))(`surface form order through ${BACKEND_NAMES[backend]}`, () => {
    searchThrough(backend)

    it(
      'writes surface forms in code point order with summed counts after the first freeze and after merges',
      async () => {
        const root = await mkdtemp(join(tmpdir(), 'narsil-surface-order-'))
        const engine = await createNarsil({
          workers: { enabled: false },
          durability: { directory: root, compactionThreshold: 1 },
        })
        try {
          await engine.createIndex(INDEX, {
            schema: { body: 'string' },
            language: 'english',
            partitions: { maxPartitions: 1 },
          })
          const bodies = new Map<string, string>()
          let mergedDocuments = 0
          for (let batch = 0; batch < BATCHES; batch++) {
            const documents = Array.from({ length: DOCUMENTS_PER_BATCH }, (_, at) => {
              const ordinal = batch * DOCUMENTS_PER_BATCH + at
              return { id: `jar-${String(ordinal).padStart(4, '0')}`, body: bodyAt(ordinal) }
            })
            expect((await engine.insertBatch(INDEX, documents)).failed).toEqual([])
            for (const document of documents) bodies.set(document.id, document.body)
            await engine.checkpoint(INDEX)
            for (const key of await listedSegments(root)) {
              const { stored, expected, documents: held } = await segmentSurfaces(root, key, bodies)
              expect(stored, key).toEqual(expected)
              mergedDocuments = Math.max(mergedDocuments, held)
            }
          }
          expect(mergedDocuments).toBeGreaterThan(DOCUMENTS_PER_BATCH)
        } finally {
          await engine.shutdown()
          await rm(root, { recursive: true, force: true })
        }
      },
      TEST_TIMEOUT_MS,
    )
  })
}
