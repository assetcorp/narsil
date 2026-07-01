import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { unzipSync } from 'fflate'
import { archiveCachePath, archiveMemberPrefix, datasetsCacheDir, REGISTRY } from './registry'
import type { BeirDatasetName, LoadBeirOptions } from './types'

const DOWNLOAD_TIMEOUT_MS = 300_000

export async function fetchArchive(name: BeirDatasetName, options: LoadBeirOptions): Promise<Buffer> {
  const cachePath = archiveCachePath(name)
  if (!options.refresh && existsSync(cachePath)) {
    return readFile(cachePath)
  }
  if (options.noDownload) {
    throw new Error(
      `BEIR archive for '${name}' is not cached and --no-download is set; run without --no-download first`,
    )
  }
  return downloadArchive(name, cachePath)
}

async function downloadArchive(name: BeirDatasetName, cachePath: string): Promise<Buffer> {
  const { url } = REGISTRY[name]
  console.log(`  downloading BEIR ${name} from ${url}`)
  const response = await fetch(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) })
  if (!response.ok) {
    throw new Error(`failed to download BEIR ${name}: ${response.status} ${response.statusText}`)
  }
  const bytes = Buffer.from(await response.arrayBuffer())

  mkdirSync(datasetsCacheDir(), { recursive: true })
  const tempPath = `${cachePath}.${process.pid}.tmp`
  try {
    writeFileSync(tempPath, bytes)
    renameSync(tempPath, cachePath)
  } catch (error) {
    rmSync(tempPath, { force: true })
    throw error
  }
  console.log(`  cached ${(bytes.length / 1024 / 1024).toFixed(1)}MB to ${cachePath}`)
  return bytes
}

export interface ArchiveEntries {
  corpus: Uint8Array
  queries: Uint8Array
  qrelsTest: Uint8Array
}

export function extractEntries(zip: Uint8Array, name: BeirDatasetName): ArchiveEntries {
  const prefix = archiveMemberPrefix(name)
  const files = unzipSync(zip, {
    filter: file =>
      file.name === `${prefix}corpus.jsonl` ||
      file.name === `${prefix}queries.jsonl` ||
      file.name === `${prefix}qrels/test.tsv`,
  })
  const corpus = files[`${prefix}corpus.jsonl`]
  const queries = files[`${prefix}queries.jsonl`]
  const qrelsTest = files[`${prefix}qrels/test.tsv`]
  if (!corpus || !queries || !qrelsTest) {
    throw new Error(`BEIR archive '${name}' is missing expected members (corpus.jsonl, queries.jsonl, qrels/test.tsv)`)
  }
  return { corpus, queries, qrelsTest }
}
