import type { PartitionManager } from '../../partitioning/manager'
import type { IndexMetadata } from '../../types/internal'
import type { VectorIndex } from '../../vector/vector-index'
import { decodeEarlierManifest } from './earlier-layout/manifest'
import { type EarlierLayout, type LayoutUpgradeEvent, upgradeEarlierLayout } from './earlier-layout/upgrade'
import type { PartitionCheckpoint } from './partition-checkpoint'
import { snapshotBundleKey } from './segment/layout'
import { loadSegmentedCheckpoint, readSegmentManifest, reclaimUnlistedKeys } from './segment/load'
import { manifestReferencedKeys } from './segment/manifest'
import type { DecodedManifest } from './segment/manifest-decode'
import type { CheckpointStore } from './segment/store'

export interface CheckpointRecoveryDeps {
  store: CheckpointStore
  indexName: string
  metadata: IndexMetadata
  manager: PartitionManager
  vectorIndexes: Map<string, VectorIndex>
  storedTermsAreCurrent: boolean
  compactionThreshold: number
  keepsUnlistedFiles: boolean
  replay(checkpoint: PartitionCheckpoint[]): Promise<PartitionCheckpoint[]>
  onLayoutUpgrade?(event: LayoutUpgradeEvent): void
}

export interface RecoveredCheckpoint {
  checkpoint: PartitionCheckpoint[]
  upgradedDocumentCount: number | null
}

async function earlierLayoutOf(
  deps: CheckpointRecoveryDeps,
  decoded: DecodedManifest | null,
): Promise<EarlierLayout | null> {
  if (decoded?.kind === 'earlier') return { kind: 'manifest', manifest: decodeEarlierManifest(decoded.payload) }
  if (decoded !== null) return null
  const bundle = await deps.store.read(snapshotBundleKey(deps.indexName))
  return bundle === null ? null : { kind: 'bundle', bytes: bundle }
}

export async function recoverCheckpoint(deps: CheckpointRecoveryDeps): Promise<RecoveredCheckpoint> {
  const decoded = await readSegmentManifest(deps.store, deps.indexName)
  const earlier = await earlierLayoutOf(deps, decoded)
  if (earlier !== null) {
    const upgraded = await upgradeEarlierLayout(deps, earlier)
    return { checkpoint: upgraded.checkpoint, upgradedDocumentCount: upgraded.documentCount }
  }
  if (decoded === null || decoded.kind !== 'current') {
    if (!deps.keepsUnlistedFiles) await reclaimUnlistedKeys(deps.store, deps.indexName, new Set())
    return { checkpoint: await deps.replay([]), upgradedDocumentCount: null }
  }
  await deps.store.remove(snapshotBundleKey(deps.indexName))
  if (!deps.keepsUnlistedFiles) {
    await reclaimUnlistedKeys(deps.store, deps.indexName, manifestReferencedKeys(decoded.manifest))
  }
  const checkpoint = await loadSegmentedCheckpoint(deps.store, deps.indexName, decoded.manifest, {
    manager: deps.manager,
    vectorIndexes: deps.vectorIndexes,
  })
  return { checkpoint: await deps.replay(checkpoint), upgradedDocumentCount: null }
}
