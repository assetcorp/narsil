import { crc32 } from 'node:zlib'
import { decode } from '@msgpack/msgpack'
import { afterEach, describe, expect, it } from 'vitest'
import { ErrorCodes, NarsilError } from '../../../errors'
import type { Narsil } from '../../../narsil'
import {
  bytesOf,
  decodedPayload,
  entryNamed,
  openEnvelope,
  readTar,
  resealed,
  type TarEntry,
  withEntry,
  writeTar,
} from './archive-oracle'
import {
  CATALOG_CONFIG,
  catalogOf,
  documentsOf,
  ENGINE_KINDS,
  insertCatalog,
  storedForm,
  temporaryRoots,
} from './harness'

const roots = temporaryRoots()
const engines: Narsil[] = []

afterEach(async () => {
  for (const engine of engines.splice(0)) await engine.shutdown()
  await roots.removeAll()
})

async function refusalOf(engine: Narsil, indexName: string, data: Uint8Array): Promise<NarsilError> {
  try {
    await engine.restore(indexName, data)
  } catch (error) {
    if (error instanceof NarsilError) return error
    throw error
  }
  throw new Error('the engine restored a hostile archive')
}

function listedFiles(entries: readonly TarEntry[]): Array<{ key: string; bytes: number; checksum: number }> {
  const manifest = decodedPayload(entryNamed(entries, 'manifest').data) as {
    partitions: Array<{ segments: Array<{ key: string; bytes: number; checksum: number }> }>
    vectors: Array<{ files: Array<{ key: string; bytes: number; checksum: number }>; graphParts: [] }>
  }
  return [
    ...manifest.partitions.flatMap(partition => partition.segments),
    ...manifest.vectors.flatMap(field => [...field.files, ...field.graphParts]),
  ]
}

function corruptOneByte(entries: readonly TarEntry[], name: string, at: number): TarEntry[] {
  const original = entryNamed(entries, name).data
  const data = original.slice()
  data[at] ^= 0xff
  return withEntry(entries, name, data)
}

describe.each(ENGINE_KINDS)('the snapshot archive of $name', kind => {
  async function sourceWithCatalog() {
    const opened = await kind.open(roots)
    engines.push(opened.engine)
    await opened.engine.createIndex('catalog', CATALOG_CONFIG)
    const documents = catalogOf(120)
    await insertCatalog(opened.engine, 'catalog', documents)
    const entries = readTar(await bytesOf(await opened.engine.snapshot('catalog')))
    return { engine: opened.engine, documents, entries }
  }

  it('holds the configuration, the manifest, then every listed file with its listed length and checksum', async () => {
    const { entries } = await sourceWithCatalog()

    expect(entries.map(entry => entry.type)).toEqual(entries.map(() => 0x30))
    expect(entries[0].name).toBe('config')
    expect(entries[1].name).toBe('manifest')
    const config = openEnvelope(entries[0].data)
    expect(config.version).toBe(5)
    expect((decode(config.payload) as Record<string, unknown>).schema).toEqual(CATALOG_CONFIG.schema)
    const manifest = openEnvelope(entries[1].data)
    expect(manifest.version).toBe(2)
    expect((decode(manifest.payload) as Record<string, unknown>).version).toBe(7)

    const files = listedFiles(entries)
    expect(entries.slice(2).map(entry => entry.name)).toEqual(files.map(file => file.key.replace(/^catalog\//, '')))
    for (const [i, file] of files.entries()) {
      const data = entries[i + 2].data
      expect(data.byteLength).toBe(file.bytes)
      expect(crc32(openEnvelope(data).payload)).toBe(file.checksum)
    }
  })

  it('refuses every hostile archive and leaves the index it would replace whole', async () => {
    const { engine, documents, entries } = await sourceWithCatalog()
    const segmentName = entries[2].name
    const hostile: Array<[string, Uint8Array, string[]]> = [
      ['random bytes', new Uint8Array(4096).fill(7), [ErrorCodes.PERSISTENCE_LOAD_FAILED]],
      ['an archive cut inside a file', writeTar(entries).subarray(0, 2048 + 700), [ErrorCodes.PERSISTENCE_LOAD_FAILED]],
      [
        'the manifest before the configuration',
        writeTar([entries[1], entries[0], ...entries.slice(2)]),
        [ErrorCodes.PERSISTENCE_LOAD_FAILED],
      ],
      [
        'an entry the manifest does not list',
        writeTar([...entries, { name: 'segments/9/evil', data: new Uint8Array(64) }]),
        [ErrorCodes.PERSISTENCE_LOAD_FAILED],
      ],
      [
        'an entry listed twice',
        writeTar([...entries.slice(0, 3), entries[2], ...entries.slice(3)]),
        [ErrorCodes.PERSISTENCE_LOAD_FAILED],
      ],
      [
        'a symbolic link',
        writeTar(entries.map((entry, i) => (i === 2 ? { ...entry, type: 0x32 } : entry))),
        [ErrorCodes.PERSISTENCE_LOAD_FAILED],
      ],
      [
        'a directory entry',
        writeTar(entries.map((entry, i) => (i === 2 ? { ...entry, type: 0x35 } : entry))),
        [ErrorCodes.PERSISTENCE_LOAD_FAILED],
      ],
      [
        'a path that climbs out of the index',
        writeTar(entries.map((entry, i) => (i === 2 ? { ...entry, name: '../../escaped' } : entry))),
        [ErrorCodes.PERSISTENCE_LOAD_FAILED],
      ],
      [
        'a file longer than the manifest lists',
        writeTar(withEntry(entries, segmentName, new Uint8Array([...entries[2].data, 0]))),
        [ErrorCodes.PERSISTENCE_LOAD_FAILED],
      ],
      [
        'a corrupt byte inside a segment',
        writeTar(corruptOneByte(entries, segmentName, entries[2].data.byteLength - 3)),
        [ErrorCodes.PERSISTENCE_CRC_MISMATCH],
      ],
      [
        'a configuration of a later envelope',
        writeTar(withEntry(entries, 'config', withVersion(entries[0].data, 6))),
        [ErrorCodes.ENVELOPE_VERSION_MISMATCH],
      ],
      [
        'a schema with an unknown field type',
        writeTar(
          withEntry(
            entries,
            'config',
            resealed(entries[0].data, raw => ({ ...raw, schema: { title: 'glob' } })),
          ),
        ),
        [ErrorCodes.SCHEMA_INVALID_TYPE],
      ],
      [
        'a configuration that disagrees with the manifest',
        writeTar(
          withEntry(
            entries,
            'config',
            resealed(entries[0].data, raw => ({ ...raw, schema: { ...CATALOG_CONFIG.schema, price: 'string' } })),
          ),
        ),
        [ErrorCodes.PERSISTENCE_LOAD_FAILED],
      ],
      [
        'a manifest of layout 6',
        writeTar(
          withEntry(
            entries,
            'manifest',
            resealed(entries[1].data, raw => ({ ...raw, version: 6 })),
          ),
        ),
        [ErrorCodes.PERSISTENCE_LOAD_FAILED],
      ],
      [
        'a manifest whose checksum fails',
        writeTar(corruptOneByte(entries, 'manifest', entries[1].data.byteLength - 2)),
        [ErrorCodes.PERSISTENCE_CRC_MISMATCH],
      ],
    ]

    for (const [what, data, codes] of hostile) {
      const refusal = await refusalOf(engine, 'catalog', data)
      expect(codes, `${what}: ${refusal.code} ${refusal.message}`).toContain(refusal.code)
      expect(await documentsOf(engine, 'catalog', documents.keys()), what).toEqual(storedForm(documents))
    }
    expect((await engine.query('catalog', { term: 'harbour', limit: 200 })).count).toBeGreaterThan(0)
  })

  it('refuses an empty upload and a value that holds no bytes', async () => {
    const { engine } = await sourceWithCatalog()

    expect((await refusalOf(engine, 'catalog', new Uint8Array(0))).code).toBe(ErrorCodes.DOC_VALIDATION_FAILED)
    await expect(engine.restore('catalog', 'not bytes' as unknown as Uint8Array)).rejects.toMatchObject({
      code: ErrorCodes.DOC_VALIDATION_FAILED,
    })
  })
})

function withVersion(envelope: Uint8Array, version: number): Uint8Array {
  const copy = envelope.slice()
  copy[4] = version
  return copy
}
