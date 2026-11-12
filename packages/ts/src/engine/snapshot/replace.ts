import {
  arrayPositionsAreStale,
  ErrorCodes,
  emitSyncChange,
  isCompositePartition,
  NarsilError,
  newSyncEpoch,
  oneSyncChangeAtATime,
} from '#platform/storage-host'
import type { PagedSegmentAccess } from '../../core/partition/frozen'
import type { PartitionManager } from '../../partitioning/manager'
import type { PartitionCheckpoint } from '../../persistence/durability/partition-checkpoint'
import type { RestoreStaging } from '../../persistence/durability/restore-staging'
import { SINGLE_NODE_PRIMARY_TERM } from '../../persistence/durability/seq-owner'
import type { StoredBytes } from '../../persistence/durability/stored-bytes'
import { writeMetadataEnvelope } from '../../serialization/envelope'
import type { VectorIndex } from '../../vector/vector-index'
import type { DetachedIndex } from '../../workers/direct-executor'
import type { IndexRegistryEntry } from '../core'
import { indexMetadataOf } from '../durability-metadata'
import { type PreparedIndex, type RestoreDeps, type RestoredHistorySink, restoredRegistryEntry } from './restore-setup'

export interface RestoredIndex {
  prepared: PreparedIndex
  detached: DetachedIndex
  staging: RestoreStaging | null
  checkpoint: readonly PartitionCheckpoint[]
  saved: StoredBytes | null
}

interface CopyRelease {
  reloads: boolean
  held: VectorIndex[]
  settled: Promise<void>
  timedOut: boolean
}

function releaseTimedOut(indexName: string, timeoutMs: number): NarsilError {
  return new NarsilError(
    ErrorCodes.WORKER_TIMEOUT,
    `The restore of index "${indexName}" stopped because a worker held the index past ${timeoutMs} ms, and the index keeps its earlier contents`,
    { indexName, timeoutMs },
  )
}

async function withinLimit(indexName: string, release: CopyRelease, work: Promise<void>, deps: RestoreDeps) {
  release.settled = work.catch(() => {
    release.reloads = true
  })
  let timer: ReturnType<typeof setTimeout> | undefined
  const limit = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      release.timedOut = true
      reject(releaseTimedOut(indexName, deps.releaseTimeoutMs))
    }, deps.releaseTimeoutMs)
  })
  try {
    await Promise.race([work, limit])
  } finally {
    clearTimeout(timer)
  }
}

function vectorIndexesOf(indexName: string, deps: RestoreDeps): VectorIndex[] {
  const manager = deps.executor.getManager(indexName)
  return manager === undefined ? [] : [...manager.getVectorIndexes().values()]
}

async function holdVectorCopies(vectorIndexes: readonly VectorIndex[], release: CopyRelease): Promise<void> {
  for (const vectorIndex of vectorIndexes) {
    if (release.held.includes(vectorIndex)) continue
    release.held.push(vectorIndex)
    await vectorIndex.holdWorkerCopies()
  }
}

async function releaseCopies(indexName: string, release: CopyRelease, deps: RestoreDeps): Promise<void> {
  release.reloads = await deps.copies.releaseIndexCopies(indexName)
  await holdVectorCopies(vectorIndexesOf(indexName, deps), release)
}

async function endRelease(indexName: string, release: CopyRelease, deps: RestoreDeps): Promise<void> {
  await release.settled
  for (const vectorIndex of release.held) vectorIndex.resumeWorkerCopies()
  await deps.copies.endCopyRelease(indexName, release.reloads)
}

function persistedCheckpoint(indexName: string, partitionCount: number, deps: RestoreDeps): PartitionCheckpoint[] {
  const durable = deps.durability?.manager
  if (durable === undefined) return []
  return Array.from({ length: partitionCount }, (_, partitionId) => ({
    partitionId,
    lastSeqNo: durable.highestPersistedSeqNo(indexName, partitionId),
    primaryTerm: SINGLE_NODE_PRIMARY_TERM,
  }))
}

function pagedSegmentsOf(manager: PartitionManager | undefined): PagedSegmentAccess[] {
  const paged: PagedSegmentAccess[] = []
  if (manager === undefined) return paged
  for (let partitionId = 0; partitionId < manager.partitionCount; partitionId++) {
    const partition = manager.getPartition(partitionId)
    if (!isCompositePartition(partition)) continue
    for (const segment of partition.frozenSegments()) if (segment.paged !== null) paged.push(segment.paged)
  }
  return paged
}

function samePath(path: string): string {
  return path
}

async function commitToStorage(
  indexName: string,
  restored: RestoredIndex,
  previous: PartitionManager | undefined,
  deps: RestoreDeps,
) {
  const durable = deps.durability?.manager
  const staging = restored.staging
  if (durable === undefined || staging === null) return
  const previousPartitions = previous?.partitionCount ?? 0
  const previousCheckpoint = persistedCheckpoint(indexName, previousPartitions, deps)
  if (previousPartitions > 0) await durable.unloadIndex(indexName)
  const vectorIndexes = [...restored.detached.manager.getVectorIndexes().values()]
  try {
    for (const vectorIndex of vectorIndexes) await vectorIndex.releaseVectorFiles()
    await staging.commit()
  } catch (error) {
    if (previousPartitions > 0) {
      durable.adoptRestoredCheckpoint?.(indexName, previousCheckpoint)
      await durable.measureRestoredStorage?.(indexName).catch(() => undefined)
    }
    throw error
  }
  for (const paged of pagedSegmentsOf(previous)) paged.close()
  const restoredSegments = pagedSegmentsOf(restored.detached.manager)
  for (const paged of restoredSegments) paged.suspend()
  await staging.finish()
  await durable.measureRestoredStorage?.(indexName, restored.saved ?? undefined).catch(() => undefined)
  const relocate = await staging.relocation().catch(() => null)
  for (const paged of restoredSegments) paged.resume(relocate ?? samePath)
  if (relocate === null) return
  for (const vectorIndex of vectorIndexes) vectorIndex.relocateVectorFiles(relocate)
}

function activate(indexName: string, restored: RestoredIndex, entry: IndexRegistryEntry, deps: RestoreDeps): void {
  deps.executor.installDetachedIndex(restored.detached)
  deps.indexRegistry.set(indexName, entry)
  entry.storedSizes?.recordSavedBytes(entry.savedBytes)
  restored.detached.attach()
  deps.clearAnalysisStale(indexName)
  const { prepared } = restored
  if (
    prepared.storedRevision !== prepared.language.revision ||
    arrayPositionsAreStale(prepared.config, prepared.storedArrayPositionGap)
  ) {
    deps.markAnalysisStale({
      indexName,
      language: prepared.language.name,
      storedRevision: prepared.storedRevision,
      currentRevision: prepared.language.revision,
    })
  }
  if (restored.staging !== null) deps.durability?.manager.adoptRestoredCheckpoint?.(indexName, restored.checkpoint)
  deps.forgetWatermark(indexName)
}

async function replaceExisting(
  indexName: string,
  restored: RestoredIndex,
  entry: IndexRegistryEntry,
  deps: RestoreDeps,
) {
  const release: CopyRelease = { reloads: false, held: [], settled: Promise.resolve(), timedOut: false }
  try {
    await deps.abandonAnalysisChange(indexName)
    await withinLimit(indexName, release, releaseCopies(indexName, release, deps), deps)
    await deps.indexState.replace(indexName, async wasOpen => {
      await deps.abandonAnalysisRebuild(indexName)
      const previous = wasOpen ? deps.executor.getManager(indexName) : undefined
      const vectorIndexes = previous === undefined ? [] : vectorIndexesOf(indexName, deps)
      await withinLimit(indexName, release, holdVectorCopies(vectorIndexes, release), deps)
      for (const vectorIndex of vectorIndexes) await vectorIndex.releaseVectorFiles()
      await commitToStorage(indexName, restored, previous, deps)
      if (previous === undefined) activate(indexName, restored, entry, deps)
      else await previous.publication.write(() => activate(indexName, restored, entry, deps))
      await deps.querySuggestions?.afterActivate(entry)
    })
  } finally {
    const ending = endRelease(indexName, release, deps).catch(() => undefined)
    if (!release.timedOut) await ending
  }
}

async function createFresh(indexName: string, restored: RestoredIndex, entry: IndexRegistryEntry, deps: RestoreDeps) {
  deps.copies.desyncIndex(indexName)
  deps.executor.installDetachedIndex(restored.detached)
  deps.indexRegistry.set(indexName, entry)
  entry.storedSizes?.recordSavedBytes(entry.savedBytes)
  try {
    await deps.indexState.registerReplacing(indexName, async () => {
      await commitToStorage(indexName, restored, undefined, deps)
      activate(indexName, restored, entry, deps)
      await deps.querySuggestions?.afterActivate(entry)
    })
  } catch (error) {
    if (deps.indexRegistry.get(indexName) === entry) deps.indexRegistry.delete(indexName)
    throw error
  } finally {
    await deps.copies.resyncIndex(indexName, false).catch(() => undefined)
  }
}

async function stageMetadata(indexName: string, staging: RestoreStaging, entry: IndexRegistryEntry): Promise<void> {
  const metadata = indexMetadataOf(indexName, entry, entry.partitionCount)
  await staging.store.write(`${indexName}/meta`, [await writeMetadataEnvelope(metadata, { checksum: true })])
}

export async function installRestoredIndex(
  indexName: string,
  restored: RestoredIndex,
  deps: RestoreDeps,
  history: RestoredHistorySink | null = null,
) {
  const entry = restoredRegistryEntry(indexName, restored.prepared, restored.detached.manager, deps)
  const previousSync = deps.indexRegistry.get(indexName)?.sync ?? null
  const previousChanges = deps.indexRegistry.get(indexName)?.changes ?? null
  const renewsEpoch = previousSync !== null || previousChanges !== null
  if (renewsEpoch) {
    const epoch = newSyncEpoch()
    if (previousSync !== null) entry.sync = { ...previousSync, active: false, epoch }
    if (previousChanges !== null) entry.changes = { ...previousChanges, epoch }
  }
  if (restored.saved !== null) entry.savedBytes = restored.saved.bytes
  let replaced: IndexRegistryEntry | undefined
  try {
    if (deps.indexRegistry.has(indexName)) await deps.abandonAnalysisChange(indexName)
    await deps.querySuggestions?.beforeInstall(entry, deps.indexRegistry.get(indexName))
    if (restored.staging !== null) await stageMetadata(indexName, restored.staging, entry)
    replaced = deps.indexRegistry.get(indexName)
    if (replaced !== undefined) await replaceExisting(indexName, restored, entry, deps)
    else await createFresh(indexName, restored, entry, deps)
  } catch (error) {
    if (deps.executor.getManager(indexName) === restored.detached.manager) deps.executor.dropIndex(indexName)
    else deps.executor.discardDetachedIndex(restored.detached)
    throw error
  }
  await restored.staging?.removeRetired().catch(() => undefined)
  const durable = deps.durability?.manager
  if (restored.staging === null && durable !== undefined) {
    await durable.persistMetadata(indexName)
    await durable.checkpoint(indexName)
  }
  if (renewsEpoch) {
    const storage = durable?.syncStorage?.()
    if (storage !== undefined)
      await oneSyncChangeAtATime(deps.indexRegistry, indexName, () => storage.release(indexName))
    emitSyncChange(deps.indexRegistry, { kind: 'epoch', indexName })
  }
  await deps.querySuggestions?.afterInstall(entry, history)
  if (replaced !== undefined) await deps.announceIndexDropped(indexName, replaced.config)
  await deps.announceIndexCreated(indexName, restored.prepared.config)
  for (const vectorIndex of restored.detached.manager.getVectorIndexes().values()) {
    vectorIndex.scheduleBuild()
    vectorIndex.startShuffledRebuildWhenDue()
  }
}
