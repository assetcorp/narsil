import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { gunzipSync } from 'node:zlib'
import { decodeBackupManifest } from '../../../ts/src/distribution/backups/manifest'
import { NarsilError } from '../../../ts/src/errors'
import { createNarsil } from '../../../ts/src/narsil'
import type { Narsil } from '../../../ts/src/types/engine'
import { withinDeadline } from '../deadline'
import type { JsonObject } from '../forms/json'
import { SAMPLES_ROOT } from '../samples/catalog'
import { exportedDocuments } from '../samples/earlier'
import type { DamagedCase } from './case'

const VECTOR_TYPE = /^vector\[(\d+)\]$/
const MAX_EXPORT_BYTES = 134_217_728

export type CaseOutcome =
  | { refused: string }
  | { documents: JsonObject }
  | { imported: number; refusedLines: { line: number; code: string }[] }

async function searchEveryVectorField(narsil: Narsil, indexName: string): Promise<void> {
  for (const [field, type] of Object.entries(narsil.getStats(indexName).schema)) {
    const match = typeof type === 'string' ? VECTOR_TYPE.exec(type) : null
    if (match === null) continue
    const value = Array.from({ length: Number(match[1]) }, (_, at) => (at === 0 ? 1 : 0))
    await narsil.query(indexName, { mode: 'vector', limit: 10, vector: { field, value } })
  }
}

async function openedCheckpoint(root: string, entry: Extract<DamagedCase, { open: 'checkpoint' }>) {
  const indexDirectory = join(root, entry.index)
  await cp(join(SAMPLES_ROOT, entry.base), indexDirectory, { recursive: true })
  for (const [relative, source] of Object.entries(entry.files)) {
    await mkdir(dirname(join(indexDirectory, relative)), { recursive: true })
    await writeFile(join(indexDirectory, relative), await readFile(join(SAMPLES_ROOT, source)))
  }
  const narsil = await createNarsil({ workers: { enabled: false }, durability: { directory: root } })
  try {
    if (entry.remove !== undefined) await narsil.remove(entry.index, entry.remove)
    if (entry.search !== undefined) await narsil.query(entry.index, { term: entry.search, limit: 10 })
    await searchEveryVectorField(narsil, entry.index)
    return { documents: await exportedDocuments(narsil, entry.index) }
  } finally {
    await narsil.shutdown()
  }
}

async function exportBytesOf(entry: Extract<DamagedCase, { open: 'export' }>): Promise<Uint8Array> {
  const stored = await readFile(join(SAMPLES_ROOT, entry.file))
  return new Uint8Array(entry.gzip === true ? gunzipSync(stored, { maxOutputLength: MAX_EXPORT_BYTES }) : stored)
}

async function openedBackupManifest(entry: Extract<DamagedCase, { open: 'backup' }>): Promise<CaseOutcome> {
  const manifest = await decodeBackupManifest(
    new Uint8Array(await readFile(join(SAMPLES_ROOT, entry.file))),
    entry.name,
  )
  return { documents: { indexName: manifest.indexName, partitionCount: manifest.partitionCount } }
}

async function openedThroughEngine(root: string, entry: Extract<DamagedCase, { open: 'archive' | 'export' }>) {
  const narsil = await createNarsil({ workers: { enabled: false }, durability: { directory: root, mode: 'sync' } })
  try {
    if (entry.open === 'archive') {
      await narsil.restore(entry.index, new Uint8Array(await readFile(join(SAMPLES_ROOT, entry.file))))
      return { documents: await exportedDocuments(narsil, entry.index) }
    }
    const result = await narsil.importDocumentExport(entry.index, await exportBytesOf(entry))
    if (result.refusedCount === 0) return { documents: await exportedDocuments(narsil, entry.index) }
    return {
      imported: result.imported,
      refusedLines: result.refused.map(refusal => ({ line: refusal.line, code: refusal.code })),
    }
  } finally {
    await narsil.shutdown()
  }
}

export async function openCase(entry: DamagedCase): Promise<CaseOutcome> {
  const root = await mkdtemp(join(tmpdir(), 'narsil-conformance-damaged-'))
  try {
    const opened: Promise<CaseOutcome> =
      entry.open === 'checkpoint'
        ? openedCheckpoint(root, entry)
        : entry.open === 'backup'
          ? openedBackupManifest(entry)
          : openedThroughEngine(root, entry)
    return await withinDeadline(opened, `the damaged file ${entry.name}`)
  } catch (error) {
    if (error instanceof NarsilError) return { refused: error.code }
    throw error
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}
