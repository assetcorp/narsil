import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { isJsonObject, type JsonObject } from '../forms/json'
import { formDifference, type SampleKind } from '../forms/kinds'
import type { VectorStorage } from '../forms/vector-kinds'
import { referenceForm } from '../reference/read'
import { writeSample } from '../reference/write'
import {
  configurationWithEveryKey,
  graphWithoutEntryPoint,
  manifestWithAnalysisGeneration,
  markerWithTornSlot,
  metadataWithEveryKey,
  segmentWithoutPositions,
} from './alternatives'
import { CATALOG_PATH, jsonText, SAMPLES_ROOT, type SampleEntry } from './catalog'
import { backupManifestOf, gzipped, partitionArchiveOf, withTermHistory, withWriteRecords } from './derive'
import { writeEarlierReleaseExpectations } from './earlier'
import { rewriteSamples } from './rewrite'
import { PRODUCTS_INDEX, writeScenario } from './scenario'

const CHECKPOINTS = 'checkpoints'
const FILES = 'files'
const LOCK_FILE = '.narsil.lock'
const KEYWORD_SEGMENT_VERSION = 4
const SEGMENT_FILE = /^segments\/(\d+)\/s(\d{16})$/
const GRAPH_PART_FILE = /^segments\/vec-.+-graph-g\d+-p(\d{16})$/
const VECTOR_FILE = /^segments\/vec-.+-f(\d{16})$/
const LOG_SEGMENT_FILE = /^wal\/(\d+)\/(\d{16})$/
const COMMIT_MARKER_FILE = /^wal\/(\d+)\/commit$/

interface Catalogued {
  entry: SampleEntry
  json: JsonObject
}

const catalogued: Catalogued[] = []

async function filesUnder(directory: string): Promise<string[]> {
  const found: string[] = []
  for (const item of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, item.name)
    if (item.isDirectory()) found.push(...(await filesUnder(path)))
    else found.push(path)
  }
  return found.sort()
}

async function catalogue(entry: SampleEntry): Promise<JsonObject> {
  const bytes = new Uint8Array(await readFile(join(SAMPLES_ROOT, entry.file)))
  const json = await referenceForm({ kind: entry.kind, bytes, what: entry.name, storage: entry.storage })
  catalogued.push({ entry, json })
  return json
}

function entryOf(kind: SampleKind, variant: string, file: string, storage?: VectorStorage): SampleEntry {
  const name = `${kind}/${variant}`
  return { name, kind, file, expected: `expected/${name}.json`, ...(storage === undefined ? {} : { storage }) }
}

async function derived(kind: SampleKind, variant: string, json: JsonObject, extension: string): Promise<JsonObject> {
  const file = `${FILES}/${kind}/${variant}${extension}`
  const storage = json.storage === 'memory' || json.storage === 'disk' ? json.storage : undefined
  const bytes = await writeSample(kind, json, `${kind}/${variant}`)
  await mkdir(dirname(join(SAMPLES_ROOT, file)), { recursive: true })
  await writeFile(join(SAMPLES_ROOT, file), bytes)
  const read = await catalogue(entryOf(kind, variant, file, storage))
  const difference = formDifference(kind, json, read)
  if (difference !== null) throw new Error(`${kind}/${variant} reads back differently: ${difference}`)
  return read
}

async function vectorStorageOf(indexDirectory: string, indexName: string): Promise<VectorStorage> {
  const metadata = await catalogue(entryOf('index-metadata', indexName, `${indexDirectory}/meta`))
  const payload = metadata.payload
  const promotion = isJsonObject(payload) ? payload.vector_promotion : undefined
  const storage = isJsonObject(promotion) ? promotion.storage : undefined
  if (storage !== 'disk' && storage !== 'memory') throw new Error(`${indexName} names no vector storage`)
  return storage
}

interface CheckpointFile {
  indexName: string
  key: string
  file: string
  bytes: Uint8Array
  storage: 'disk' | 'memory'
}

function entryOfCheckpointFile({ indexName, key, file, bytes, storage }: CheckpointFile): SampleEntry | null {
  const segment = SEGMENT_FILE.exec(key)
  if (segment !== null) {
    const kind = bytes[4] === KEYWORD_SEGMENT_VERSION ? 'keyword-segment' : 'paged-segment'
    return entryOf(kind, `${indexName}-p${segment[1]}-s${Number(segment[2])}`, file)
  }
  const graphPart = GRAPH_PART_FILE.exec(key)
  if (graphPart !== null) return entryOf('graph-part', `${indexName}-p${Number(graphPart[1])}`, file, storage)
  const vectorFile = VECTOR_FILE.exec(key)
  if (vectorFile !== null) return entryOf('vector-file', `${indexName}-f${Number(vectorFile[1])}`, file, storage)
  const logSegment = LOG_SEGMENT_FILE.exec(key)
  if (logSegment !== null) {
    return entryOf('log-segment', `${indexName}-p${logSegment[1]}-${Number(logSegment[2])}`, file)
  }
  const marker = COMMIT_MARKER_FILE.exec(key)
  return marker === null ? null : entryOf('commit-marker', `${indexName}-p${marker[1]}`, file)
}

async function catalogueCheckpoint(indexName: string): Promise<Map<string, JsonObject>> {
  const indexDirectory = `${CHECKPOINTS}/${indexName}`
  const storage = await vectorStorageOf(indexDirectory, indexName)
  const forms = new Map<string, JsonObject>()
  forms.set('manifest', await catalogue(entryOf('manifest', indexName, `${indexDirectory}/manifest`)))
  for (const path of await filesUnder(join(SAMPLES_ROOT, indexDirectory))) {
    const key = relative(join(SAMPLES_ROOT, indexDirectory), path)
    const file = `${indexDirectory}/${key}`
    const entry = entryOfCheckpointFile({ indexName, key, file, bytes: await readFile(path), storage })
    if (entry !== null) forms.set(key, await catalogue(entry))
  }
  return forms
}

async function writeCatalog(): Promise<void> {
  catalogued.sort((left, right) => left.entry.name.localeCompare(right.entry.name))
  for (const { entry, json } of catalogued) {
    await mkdir(dirname(join(SAMPLES_ROOT, entry.expected)), { recursive: true })
    await writeFile(join(SAMPLES_ROOT, entry.expected), jsonText(json))
  }
  await writeFile(CATALOG_PATH, `${JSON.stringify({ samples: catalogued.map(item => item.entry) }, null, 2)}\n`)
}

function formAt(forms: Map<string, JsonObject>, key: string): JsonObject {
  const form = forms.get(key)
  if (form === undefined) throw new Error(`the scenario wrote no ${key}`)
  return form
}

function keyMatching(forms: Map<string, JsonObject>, pattern: RegExp): string {
  const key = [...forms.keys()].find(candidate => pattern.test(candidate))
  if (key === undefined) throw new Error(`the scenario wrote no file matching ${pattern}`)
  return key
}

async function writeDerivedSamples(indexForms: Map<string, Map<string, JsonObject>>, archive: JsonObject) {
  const products = indexForms.get(PRODUCTS_INDEX)
  const notes = indexForms.get('notes')
  if (products === undefined || notes === undefined) throw new Error('the scenario wrote no products or notes index')
  const configEntry = archiveEntriesOf(archive).find(entry => entry.name === 'config')
  if (configEntry === undefined || !isJsonObject(configEntry.content)) throw new Error('the archive holds no config')
  const configBytes = await writeSample('index-configuration', configEntry.content, 'index configuration')
  await mkdir(join(SAMPLES_ROOT, FILES, 'index-configuration'), { recursive: true })
  await writeFile(join(SAMPLES_ROOT, FILES, 'index-configuration', 'products.nrsl'), configBytes)
  const config = await catalogue(
    entryOf('index-configuration', 'products', `${FILES}/index-configuration/products.nrsl`),
  )
  await derived('index-configuration', 'products-gzip', gzipped(config), '.nrsl')
  const firstSegment = formAt(products, 'segments/0/s0000000000000000')
  await derived('keyword-segment', 'products-gzip', gzipped(firstSegment), '.nrsl')
  await derived('keyword-segment', 'cluster-copy', withWriteRecords(firstSegment, 1), '.nrsl')
  const pagedSegment = formAt(notes, 'segments/0/s0000000000000000')
  await derived('paged-segment', 'cluster-copy', withWriteRecords(pagedSegment, 1), '.nrsl')
  await derived('manifest', 'products-gzip', gzipped(formAt(products, 'manifest')), '.nrsl')
  await derived('manifest', 'cluster-copy', withTermHistory(formAt(products, 'manifest')), '.nrsl')
  await derived('index-metadata', 'products-gzip', gzipped(formAt(products, 'meta')), '.nrsl')
  await derived(
    'graph-part',
    'products-gzip',
    gzipped(formAt(products, keyMatching(products, GRAPH_PART_FILE))),
    '.nrsl',
  )
  await derived('snapshot-archive', 'partition-0', partitionArchiveOf(archive), '.tar')
  const manifestBytes = await readFile(join(SAMPLES_ROOT, CHECKPOINTS, PRODUCTS_INDEX, 'manifest'))
  const listed = await filesUnder(join(SAMPLES_ROOT, CHECKPOINTS, PRODUCTS_INDEX, 'segments'))
  const files = await Promise.all(
    listed.map(async path => ({
      key: relative(join(SAMPLES_ROOT, CHECKPOINTS, PRODUCTS_INDEX), path),
      bytes: new Uint8Array(await readFile(path)),
    })),
  )
  const checkpoint = formAt(products, 'manifest').payload
  const lastSeqNo =
    isJsonObject(checkpoint) && Array.isArray(checkpoint.checkpoint) && isJsonObject(checkpoint.checkpoint[0])
      ? Number(checkpoint.checkpoint[0].lastSeqNo)
      : 0
  const backup = backupManifestOf(PRODUCTS_INDEX, lastSeqNo, configBytes, manifestBytes, files)
  await derived('backup-manifest', 'products', backup, '.nrsl')
  await writeAlternativeSamples(products, config)
}

async function writeAlternativeSamples(products: Map<string, JsonObject>, config: JsonObject): Promise<void> {
  for (const form of ['named', 'literal'] as const) {
    await derived('index-metadata', `every-key-${form}`, metadataWithEveryKey(formAt(products, 'meta'), form), '.nrsl')
    await derived('index-configuration', `every-key-${form}`, configurationWithEveryKey(config, form), '.nrsl')
  }
  const firstSegment = formAt(products, 'segments/0/s0000000000000000')
  await derived('keyword-segment', 'products-no-positions', segmentWithoutPositions(firstSegment), '.nrsl')
  const graphPart = formAt(products, keyMatching(products, GRAPH_PART_FILE))
  await derived('graph-part', 'products-no-entry-point', graphWithoutEntryPoint(graphPart), '.nrsl')
  const manifest = formAt(products, 'manifest')
  await derived('manifest', 'products-analysis-generation', manifestWithAnalysisGeneration(manifest), '.nrsl')
  const marker = formAt(products, keyMatching(products, COMMIT_MARKER_FILE))
  await derived('commit-marker', 'products-torn-slot', markerWithTornSlot(marker), '')
}

function archiveEntriesOf(archive: JsonObject): JsonObject[] {
  return Array.isArray(archive.entries) ? archive.entries.filter(isJsonObject) : []
}

async function main(): Promise<void> {
  const work = await mkdtemp(join(tmpdir(), 'narsil-conformance-samples-'))
  try {
    const output = await writeScenario(work)
    for (const directory of [CHECKPOINTS, FILES, 'expected'])
      await rm(join(SAMPLES_ROOT, directory), { recursive: true, force: true })
    await cp(output.checkpoint, join(SAMPLES_ROOT, CHECKPOINTS), {
      recursive: true,
      filter: source => !source.endsWith(LOCK_FILE),
    })
    await mkdir(join(SAMPLES_ROOT, FILES, 'snapshot-archive'), { recursive: true })
    await mkdir(join(SAMPLES_ROOT, FILES, 'document-export'), { recursive: true })
    await writeFile(join(SAMPLES_ROOT, FILES, 'snapshot-archive', 'products.tar'), output.archive)
    await writeFile(join(SAMPLES_ROOT, FILES, 'document-export', 'products.jsonl'), output.exported)
    const archive = await catalogue(entryOf('snapshot-archive', 'products', `${FILES}/snapshot-archive/products.tar`))
    await catalogue(entryOf('document-export', 'products', `${FILES}/document-export/products.jsonl`))
    const indexForms = new Map<string, Map<string, JsonObject>>()
    for (const indexName of (await readdir(join(SAMPLES_ROOT, CHECKPOINTS))).sort()) {
      const forms = await catalogueCheckpoint(indexName)
      const meta = catalogued.find(item => item.entry.name === `index-metadata/${indexName}`)
      if (meta !== undefined) forms.set('meta', meta.json)
      indexForms.set(indexName, forms)
    }
    await writeDerivedSamples(indexForms, archive)
    await writeCatalog()
    await writeEarlierReleaseExpectations()
    console.log(`wrote ${catalogued.length} samples under ${SAMPLES_ROOT}`)
  } finally {
    await rm(work, { recursive: true, force: true })
  }
}

const ONLY_FLAG = '--only'

function chosenSamples(argv: readonly string[]): string[] | null {
  const at = argv.indexOf(ONLY_FLAG)
  if (at === -1) return null
  const names = (argv[at + 1] ?? '').split(',').filter(name => name.length > 0)
  if (names.length === 0) throw new Error(`${ONLY_FLAG} takes a comma-separated list of sample names`)
  return names
}

const chosen = chosenSamples(process.argv.slice(2))
if (chosen === null) {
  await main()
} else {
  const rewritten = await rewriteSamples(chosen)
  console.log(`rewrote ${rewritten.join(', ')} under ${SAMPLES_ROOT}`)
}
