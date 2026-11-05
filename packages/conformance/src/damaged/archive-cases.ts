import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { MAX_FILE_BYTES } from '../../../ts/src/serialization/constants'
import { archiveEntries } from '../forms/archive-kinds'
import { SAMPLES_ROOT } from '../samples/catalog'
import type { CaseBuild, FileBuild } from './build'
import {
  bytesAt,
  fittedManifestPayload,
  mapAt,
  packedUint32s,
  type RawMap,
  rewritten,
  uint32s,
  withPayloadChecksum,
} from './bytes'
import { DIRECTORY, SYMBOLIC_LINK, type TarEntry, tarOf } from './tar'

const INDEX = 'products'
const ARCHIVE = 'files/snapshot-archive/products.tar'
const RULE = 'durability.md#snapshot-archive'
const CONFIG_RULE = 'envelope.md#index-configuration-payload'
const DOCUMENT_RULE = 'envelope.md#keyword-segment-payload'
const LOAD_FAILED = 'PERSISTENCE_LOAD_FAILED'
const CONFIG_INVALID = 'CONFIG_INVALID'
const SEGMENT = 'segments/0/s0000000000000001'
const UNLISTED_SEGMENT = 'segments/0/s0000000000000009'
const ENVELOPE_VERSION_OFFSET = 4
const EARLIER_CONFIG_ENVELOPE_VERSION = 4
const MESSAGEPACK_NIL = 0xc0

async function archiveParts(): Promise<TarEntry[]> {
  const bytes = new Uint8Array(await readFile(join(SAMPLES_ROOT, ARCHIVE)))
  return archiveEntries(bytes, ARCHIVE).map(entry => ({ name: entry.name, bytes: entry.bytes.slice() }))
}

function archiveCase(name: string, rule: string, code: string, entries: readonly TarEntry[], ends = true): FileBuild {
  return { open: 'archive', name, rule, index: INDEX, bytes: tarOf(entries, ends), gzip: false, code }
}

function entryNamed(entries: readonly TarEntry[], name: string): TarEntry {
  const entry = entries.find(candidate => candidate.name === name)
  if (entry === undefined) throw new Error(`${ARCHIVE} holds no entry named ${name}`)
  return entry
}

function replaced(entries: readonly TarEntry[], name: string, change: (entry: TarEntry) => TarEntry): TarEntry[] {
  entryNamed(entries, name)
  return entries.map(entry => (entry.name === name ? change(entry) : entry))
}

async function withFittedManifest(entries: readonly TarEntry[], name: string, bytes: Uint8Array) {
  const changed = new Map([[name, bytes]])
  const manifest = await rewritten(entryNamed(entries, 'manifest').bytes, `${ARCHIVE} manifest`, payload =>
    fittedManifestPayload(payload, INDEX, changed),
  )
  return replaced(
    replaced(entries, name, entry => ({ ...entry, bytes })),
    'manifest',
    entry => ({ ...entry, bytes: manifest }),
  )
}

function lastDocumentAsNil(segment: RawMap): void {
  const offsets = uint32s(bytesAt(segment.documentOffsets, 'documentOffsets'))
  const start = offsets.at(-2)
  if (start === undefined) throw new Error('the segment holds no document')
  const documents = bytesAt(segment.documents, 'documents')
  segment.documents = new Uint8Array([...documents.subarray(0, start), MESSAGEPACK_NIL])
  offsets[offsets.length - 1] = start + 1
  segment.documentOffsets = packedUint32s(offsets)
}

async function configCase(name: string, entries: readonly TarEntry[], change: (config: RawMap) => void) {
  const config = await rewritten(entryNamed(entries, 'config').bytes, name, change)
  return archiveCase(
    name,
    CONFIG_RULE,
    CONFIG_INVALID,
    replaced(entries, 'config', entry => ({ ...entry, bytes: config })),
  )
}

function promotionOf(config: RawMap): RawMap {
  return mapAt(config.vectorPromotion, 'vectorPromotion')
}

export async function archiveCases(): Promise<CaseBuild[]> {
  const entries = await archiveParts()
  const [config, manifest, firstFile, ...rest] = entries
  const last = entries.at(-1)
  if (config === undefined || manifest === undefined || firstFile === undefined || last === undefined) {
    throw new Error(`${ARCHIVE} holds no file after its manifest`)
  }
  const segment = entryNamed(entries, SEGMENT).bytes
  const flipped = segment.slice()
  flipped[flipped.byteLength - 1] = (flipped[flipped.byteLength - 1] ?? 0) ^ 0x01
  const nilDocument = await rewritten(segment, 'archive-document-not-a-map', lastDocumentAsNil)
  const olderConfig = config.bytes.slice()
  olderConfig[ENVELOPE_VERSION_OFFSET] = EARLIER_CONFIG_ENVELOPE_VERSION
  return [
    archiveCase('archive-entry-symbolic-link', RULE, LOAD_FAILED, [
      config,
      manifest,
      { ...firstFile, type: SYMBOLIC_LINK },
      ...rest,
    ]),
    archiveCase('archive-entry-directory', RULE, LOAD_FAILED, [
      config,
      manifest,
      { ...firstFile, type: DIRECTORY },
      ...rest,
    ]),
    archiveCase('archive-manifest-before-config', RULE, LOAD_FAILED, [manifest, config, firstFile, ...rest]),
    archiveCase('archive-entry-unlisted', RULE, LOAD_FAILED, [...entries, { name: UNLISTED_SEGMENT, bytes: segment }]),
    archiveCase('archive-entry-repeated', RULE, LOAD_FAILED, [...entries, last]),
    archiveCase(
      'archive-entry-length-differs',
      RULE,
      LOAD_FAILED,
      replaced(entries, SEGMENT, entry => ({ ...entry, bytes: new Uint8Array([...entry.bytes, 0]) })),
    ),
    archiveCase(
      'archive-entry-checksum-differs',
      RULE,
      LOAD_FAILED,
      replaced(entries, SEGMENT, entry => ({ ...entry, bytes: withPayloadChecksum(flipped) })),
    ),
    archiveCase('archive-ends-before-every-file', RULE, LOAD_FAILED, entries.slice(0, -1)),
    archiveCase(
      'archive-config-past-file-size-limit',
      RULE,
      LOAD_FAILED,
      [{ name: 'config', bytes: new Uint8Array(0), declaredSize: MAX_FILE_BYTES + 1 }],
      false,
    ),
    archiveCase(
      'archive-document-not-a-map',
      DOCUMENT_RULE,
      LOAD_FAILED,
      await withFittedManifest(entries, SEGMENT, nilDocument),
    ),
    archiveCase(
      'archive-config-envelope-version',
      CONFIG_RULE,
      'ENVELOPE_VERSION_MISMATCH',
      replaced(entries, 'config', entry => ({ ...entry, bytes: olderConfig })),
    ),
    await configCase('archive-config-quantization-outside-its-set', entries, payload => {
      promotionOf(payload).quantization = 'osq3'
    }),
    await configCase('archive-config-storage-outside-its-set', entries, payload => {
      promotionOf(payload).storage = 'tape'
    }),
    await configCase('archive-config-text-storage-outside-its-set', entries, payload => {
      payload.textStorage = 'tape'
    }),
  ]
}
