import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { manifestPath } from './registry'
import type { BeirDatasetName, BeirManifest } from './types'

export function readManifest(name: BeirDatasetName): BeirManifest | null {
  const path = manifestPath(name)
  if (!existsSync(path)) return null
  return JSON.parse(readFileSync(path, 'utf8')) as BeirManifest
}

export function writeManifest(manifest: BeirManifest): void {
  const path = manifestPath(manifest.name)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`)
}

export function assertManifestMatches(pinned: BeirManifest, actual: BeirManifest): void {
  const mismatches: string[] = []
  if (pinned.archiveSha256 !== actual.archiveSha256) {
    mismatches.push(`archive sha256 (pinned ${pinned.archiveSha256}, got ${actual.archiveSha256})`)
  }
  if (pinned.corpusFingerprint !== actual.corpusFingerprint) {
    mismatches.push(`corpus fingerprint (pinned ${pinned.corpusFingerprint}, got ${actual.corpusFingerprint})`)
  }
  if (pinned.counts.documents !== actual.counts.documents) {
    mismatches.push(`document count (pinned ${pinned.counts.documents}, got ${actual.counts.documents})`)
  }
  if (pinned.counts.queries !== actual.counts.queries) {
    mismatches.push(`query count (pinned ${pinned.counts.queries}, got ${actual.counts.queries})`)
  }
  if (pinned.counts.qrels !== actual.counts.qrels) {
    mismatches.push(`qrel count (pinned ${pinned.counts.qrels}, got ${actual.counts.qrels})`)
  }
  if (mismatches.length > 0) {
    throw new Error(
      `BEIR dataset '${actual.name}' does not match its committed pin: ${mismatches.join('; ')}. ` +
        `Delete the cached archive and re-download, or regenerate the pin with BENCH_UPDATE_BEIR_PINS=1 if the change is intended.`,
    )
  }
}
