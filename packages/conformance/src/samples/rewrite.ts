import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { readHeader } from '../../../ts/src/serialization/header'
import { isJsonObject, type Json, type JsonObject } from '../forms/json'
import { formDifference } from '../forms/kinds'
import { referenceForm } from '../reference/read'
import { writeSample } from '../reference/write'
import { jsonText, readCatalog, readExpected, SAMPLES_ROOT, type SampleEntry } from './catalog'

const CHECKPOINT_FILE = /^checkpoints\/([^/]+)\/(.+)$/
const MANIFEST_LISTS = ['segments', 'files', 'graphParts'] as const

function objectsIn(value: Json | undefined): JsonObject[] {
  return Array.isArray(value) ? value.filter(isJsonObject) : []
}

function listedFiles(manifest: JsonObject): JsonObject[] {
  const payload = manifest.payload
  if (!isJsonObject(payload)) return []
  const groups = [...objectsIn(payload.partitions), ...objectsIn(payload.vectors)]
  return groups.flatMap(group => MANIFEST_LISTS.flatMap(list => objectsIn(group[list])))
}

function entryNamed(catalog: readonly SampleEntry[], name: string): SampleEntry {
  const entry = catalog.find(candidate => candidate.name === name)
  if (entry === undefined) throw new Error(`the catalogue lists no sample named ${name}`)
  return entry
}

function manifestEntryOf(catalog: readonly SampleEntry[], indexName: string): SampleEntry {
  const entry = catalog.find(candidate => candidate.file === `checkpoints/${indexName}/manifest`)
  if (entry === undefined) throw new Error(`the catalogue lists no manifest for the ${indexName} checkpoint`)
  return entry
}

async function writeFromExpected(entry: SampleEntry, json: JsonObject): Promise<Uint8Array> {
  const bytes = await writeSample(entry.kind, json, entry.name)
  await writeFile(join(SAMPLES_ROOT, entry.file), bytes)
  return bytes
}

async function relistInManifest(
  catalog: readonly SampleEntry[],
  indexName: string,
  key: string,
  bytes: Uint8Array,
): Promise<SampleEntry> {
  const entry = manifestEntryOf(catalog, indexName)
  const manifest = await readExpected(entry)
  const listed = listedFiles(manifest).find(file => file.key === `${indexName}/${key}`)
  if (listed === undefined) throw new Error(`the ${indexName} manifest lists no file under ${key}`)
  listed.bytes = bytes.length
  listed.checksum = readHeader(bytes).checksum
  await writeFromExpected(entry, manifest)
  return entry
}

async function recordExpected(entry: SampleEntry): Promise<void> {
  const bytes = new Uint8Array(await readFile(join(SAMPLES_ROOT, entry.file)))
  const json = await referenceForm({ kind: entry.kind, bytes, what: entry.name, storage: entry.storage })
  const rewritten = await writeSample(entry.kind, json, entry.name)
  const reread = await referenceForm({ kind: entry.kind, bytes: rewritten, what: entry.name, storage: entry.storage })
  const difference = formDifference(entry.kind, json, reread)
  if (difference !== null) throw new Error(`${entry.name} reads back differently: ${difference}`)
  await writeFile(join(SAMPLES_ROOT, entry.expected), jsonText(json))
}

export async function rewriteSamples(names: readonly string[]): Promise<string[]> {
  const catalog = await readCatalog()
  const touched = new Map<string, SampleEntry>()
  for (const name of names) {
    const entry = entryNamed(catalog, name)
    const bytes = await writeFromExpected(entry, await readExpected(entry))
    touched.set(entry.name, entry)
    const checkpointFile = CHECKPOINT_FILE.exec(entry.file)
    if (checkpointFile === null || checkpointFile[2] === 'manifest') continue
    const manifest = await relistInManifest(catalog, checkpointFile[1], checkpointFile[2], bytes)
    touched.set(manifest.name, manifest)
  }
  for (const entry of touched.values()) await recordExpected(entry)
  return [...touched.keys()]
}
