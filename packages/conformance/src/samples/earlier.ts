import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import * as v from 'valibot'
import { createNarsil } from '../../../ts/src/narsil'
import { createFilesystemPersistence } from '../../../ts/src/persistence/filesystem'
import type { Narsil } from '../../../ts/src/types/engine'
import { isJsonObject, type Json, type JsonObject } from '../forms/json'
import { jsonText, SAMPLES_ROOT } from './catalog'

export const EARLIER_RELEASES_PATH = join(SAMPLES_ROOT, 'earlier-releases', 'releases.json')

const EarlierReleaseSchema = v.strictObject({
  release: v.string(),
  layout: v.picklist(['checkpoint-directory', 'snapshot-bundle', 'index-snapshot']),
  path: v.pipe(v.string(), v.regex(/^earlier-releases\/[A-Za-z0-9._/-]+$/)),
  indexes: v.record(
    v.pipe(v.string(), v.regex(/^[a-z0-9-]+$/)),
    v.pipe(v.string(), v.regex(/^earlier-releases\/.+\.json$/)),
  ),
})

const EarlierReleasesSchema = v.strictObject({ earlier: v.array(EarlierReleaseSchema) })

export type EarlierRelease = v.InferOutput<typeof EarlierReleaseSchema>

export async function readEarlierReleases(): Promise<EarlierRelease[]> {
  return v.parse(EarlierReleasesSchema, JSON.parse(await readFile(EARLIER_RELEASES_PATH, 'utf8'))).earlier
}

async function textOfStream(stream: ReadableStream<Uint8Array>): Promise<string> {
  const decoder = new TextDecoder('utf-8', { fatal: true })
  const reader = stream.getReader()
  let text = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) return text + decoder.decode()
    text += decoder.decode(value, { stream: true })
  }
}

export async function exportedDocuments(narsil: Narsil, indexName: string): Promise<JsonObject> {
  const lines = (await textOfStream(await narsil.exportDocuments(indexName))).split('\n').filter(line => line !== '')
  const documents: Record<string, Json> = {}
  for (const line of lines.slice(1)) {
    const parsed: Json = JSON.parse(line)
    if (!isJsonObject(parsed) || typeof parsed.id !== 'string')
      throw new Error(`${indexName} exported a line without an id`)
    const { id, ...document } = parsed
    documents[id] = document
  }
  const sorted: JsonObject = {}
  for (const id of Object.keys(documents).sort()) sorted[id] = documents[id]
  return sorted
}

async function openedRelease(release: EarlierRelease, root: string): Promise<Narsil> {
  const source = join(SAMPLES_ROOT, release.path)
  if (release.layout === 'index-snapshot') {
    const narsil = await createNarsil({ workers: { enabled: false }, durability: { directory: root, mode: 'sync' } })
    const [indexName] = Object.keys(release.indexes)
    if (indexName === undefined) throw new Error(`${release.path} names no index`)
    await narsil.restore(indexName, new Uint8Array(await readFile(source)))
    return narsil
  }
  await cp(source, root, { recursive: true })
  if (release.layout === 'checkpoint-directory') {
    return createNarsil({ workers: { enabled: false }, durability: { directory: root } })
  }
  return createNarsil({
    workers: { enabled: false },
    persistence: createFilesystemPersistence({ directory: root }),
    durability: { tier: 'snapshot' },
  })
}

export async function recoveredDocuments(release: EarlierRelease): Promise<Map<string, JsonObject>> {
  const root = await mkdtemp(join(tmpdir(), 'narsil-conformance-earlier-'))
  try {
    const narsil = await openedRelease(release, root)
    try {
      const recovered = new Map<string, JsonObject>()
      for (const indexName of Object.keys(release.indexes))
        recovered.set(indexName, await exportedDocuments(narsil, indexName))
      return recovered
    } finally {
      await narsil.shutdown()
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

export async function writeEarlierReleaseExpectations(): Promise<void> {
  for (const release of await readEarlierReleases()) {
    const recovered = await recoveredDocuments(release)
    for (const [indexName, expected] of Object.entries(release.indexes)) {
      const documents = recovered.get(indexName)
      if (documents === undefined) throw new Error(`${release.path} recovered no index ${indexName}`)
      await mkdir(dirname(join(SAMPLES_ROOT, expected)), { recursive: true })
      await writeFile(join(SAMPLES_ROOT, expected), jsonText(documents))
    }
  }
}
