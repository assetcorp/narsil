import { countSnapshotBundleDocuments as countBundle, decodeSnapshotBundle } from './earlier-layout/bundle'
import { decodeEarlierManifest } from './earlier-layout/manifest'
import { countLiveDocuments } from './earlier-layout/merge'
import { type EarlierSegmentContents, readEarlierSegmentContents } from './earlier-layout/segment'
import { snapshotBundleKey } from './segment/layout'
import { readSegmentManifest } from './segment/load'
import type { PartitionManifestEntry, SegmentManifest } from './segment/manifest'
import { readSegmentFile } from './segment/segment-file'
import type { CheckpointStore } from './segment/store'

const decoder = new TextDecoder()

async function countPagedPartition(store: CheckpointStore, partition: PartitionManifestEntry): Promise<number | null> {
  const { directory } = store
  if (directory === undefined || partition.segments.length === 0) return null
  const { countsAsLatestHolder, isPagedSegmentFile, openPagedSegmentScan } = await import('../paged/module')
  for (const ref of partition.segments) if (!(await isPagedSegmentFile(directory, ref.key))) return null
  const scans = []
  try {
    for (const ref of partition.segments) scans.push(await openPagedSegmentScan(directory, ref))
    let live = 0
    for (let at = 0; at < scans.length; at++) {
      for (let ordinal = 0; ordinal < scans[at].count; ordinal++) {
        if (countsAsLatestHolder(scans, at, scans[at].idAt(ordinal))) live += 1
      }
    }
    return live
  } finally {
    for (const scan of scans) scan.close()
  }
}

async function countCurrentLayout(store: CheckpointStore, manifest: SegmentManifest): Promise<number> {
  let total = 0
  for (const partition of manifest.partitions) {
    const paged = await countPagedPartition(store, partition)
    if (paged !== null) {
      total += paged
      continue
    }
    const live = new Set<string>()
    for (const ref of partition.segments) {
      const contents = await readSegmentFile(store, ref)
      for (const docId of contents.tombstones) live.delete(docId)
      const ids = contents.arrays.idTable
      for (let ordinal = 0; ordinal < contents.arrays.documentCount; ordinal++) {
        live.add(decoder.decode(ids.blob.subarray(ids.offsets[ordinal], ids.offsets[ordinal + 1])))
      }
    }
    total += live.size
  }
  return total
}

export async function countCheckpointDocuments(store: CheckpointStore, indexName: string): Promise<number> {
  const decoded = await readSegmentManifest(store, indexName)
  if (decoded?.kind === 'current') return countCurrentLayout(store, decoded.manifest)
  if (decoded?.kind === 'earlier') {
    let total = 0
    for (const partition of decodeEarlierManifest(decoded.payload).partitions) {
      const ordered: EarlierSegmentContents[] = []
      for (const segment of partition.segments) ordered.push(await readEarlierSegmentContents(store, segment.key))
      total += countLiveDocuments(ordered)
    }
    return total
  }
  const bundle = await store.read(snapshotBundleKey(indexName))
  return bundle === null ? 0 : countBundle(await decodeSnapshotBundle(bundle))
}
