import { ErrorCodes, NarsilError } from '../../../errors'
import { type BuildRecord, buildRecordFromWire, buildRecordToWire } from '../../../query-suggestions/build-record'
import type { ClusterCoordinator } from '../../coordinator/types'
import { BUILD_RECORD_KEY_PREFIX, BUILD_RECORD_KEY_SUFFIX, MAX_BUILD_RECORD_WRITE_ATTEMPTS } from './constants'

export function buildRecordCoordinatorKey(indexName: string): string {
  return `${BUILD_RECORD_KEY_PREFIX}${indexName}${BUILD_RECORD_KEY_SUFFIX}`
}

export async function readClusterBuildRecord(
  coordinator: ClusterCoordinator,
  indexName: string,
): Promise<BuildRecord | null> {
  const bytes = await coordinator.get(buildRecordCoordinatorKey(indexName))
  if (bytes === null || bytes.byteLength === 0) return null
  return buildRecordFromWire(bytes)
}

export async function writeClusterBuildRecord(
  coordinator: ClusterCoordinator,
  indexName: string,
  record: BuildRecord,
): Promise<void> {
  const key = buildRecordCoordinatorKey(indexName)
  const next = buildRecordToWire(record)
  for (let attempt = 1; attempt <= MAX_BUILD_RECORD_WRITE_ATTEMPTS; attempt++) {
    const current = await coordinator.get(key)
    if (await coordinator.compareAndSet(key, current, next)) return
  }
  throw new NarsilError(
    ErrorCodes.CLUSTER_WRITE_BLOCKED,
    `The build record of index '${indexName}' kept changing, so the controller stored no outcome for build '${record.buildId}'`,
    { indexName, buildId: record.buildId, attempts: MAX_BUILD_RECORD_WRITE_ATTEMPTS },
  )
}

export async function deleteClusterBuildRecord(coordinator: ClusterCoordinator, indexName: string): Promise<void> {
  await coordinator.delete(buildRecordCoordinatorKey(indexName))
}
