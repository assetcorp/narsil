import { ErrorCodes, NarsilError } from '../../../errors'
import { publicBuildOf } from '../../../query-suggestions/build-record'
import type { QuerySuggestionsBuild } from '../../../types/query-suggestions'
import { CONTROLLER_LEASE_KEY } from '../../cluster/controller/types'
import { pause } from '../../cluster/rebalance/pause'
import { exchangeRebalanceMessage } from '../../cluster/rebalance/reply'
import { SuggestionMessageTypes } from '../../transport/types'
import { resolveNodeTargets } from '../node-messaging'
import type { ClusterNodeConfig } from '../types'
import { readClusterBuildRecord } from './build-records'
import { BUILD_RECORD_POLL_INTERVAL_MS } from './constants'

export interface BuildRequestDeps {
  config: ClusterNodeConfig
  nodeId: string
  guard(): void
}

function noController(indexName: string): NarsilError {
  return new NarsilError(
    ErrorCodes.NODE_NOT_CONTROLLER,
    `No node holds the controller lease, so the build of the suggestions of index '${indexName}' cannot start`,
    { indexName },
  )
}

function skippedBuild(buildId: string): QuerySuggestionsBuild {
  const now = Date.now()
  return {
    buildId,
    trigger: 'caller',
    status: 'skipped',
    startedAt: now,
    endedAt: now,
    published: 0,
    removed: 0,
    discarded: 0,
    errorCode: null,
  }
}

function lostBuild(indexName: string, buildId: string, reason: string): NarsilError {
  return new NarsilError(
    ErrorCodes.ALLOCATION_FAILED,
    `The outcome of build '${buildId}' of the suggestions of index '${indexName}' is unknown, because ${reason}`,
    { indexName, buildId },
  )
}

async function awaitBuild(
  deps: BuildRequestDeps,
  indexName: string,
  buildId: string,
  controllerNodeId: string,
): Promise<QuerySuggestionsBuild> {
  const { coordinator } = deps.config
  for (;;) {
    deps.guard()
    const record = await readClusterBuildRecord(coordinator, indexName)
    if (record === null || record.buildId !== buildId) {
      throw lostBuild(indexName, buildId, 'another build or a drop replaced its record')
    }
    if (record.status !== 'running') return publicBuildOf(record)
    if ((await coordinator.getLeaseHolder(CONTROLLER_LEASE_KEY)) !== controllerNodeId) {
      throw lostBuild(indexName, buildId, `node '${controllerNodeId}' gave up the controller lease while it ran`)
    }
    await pause(BUILD_RECORD_POLL_INTERVAL_MS)
  }
}

export async function requestClusterBuild(deps: BuildRequestDeps, indexName: string): Promise<QuerySuggestionsBuild> {
  deps.guard()
  const controllerNodeId = await deps.config.coordinator.getLeaseHolder(CONTROLLER_LEASE_KEY)
  if (controllerNodeId === null) throw noController(indexName)
  const failureMessage = `The controller '${controllerNodeId}' did not answer the build of the suggestions of index '${indexName}'`
  const reply = await exchangeRebalanceMessage({
    transport: deps.config.transport,
    senderId: deps.nodeId,
    targets: await resolveNodeTargets(deps.config, controllerNodeId),
    type: SuggestionMessageTypes.BUILD,
    payload: { indexName, trigger: 'caller' },
    failureMessage,
    details: { indexName, controllerNodeId },
  })
  const { buildId, status } = reply
  if (typeof buildId !== 'string' || (status !== 'running' && status !== 'skipped')) {
    throw new NarsilError(ErrorCodes.ALLOCATION_FAILED, `${failureMessage}: the answer was unreadable`, {
      indexName,
      controllerNodeId,
    })
  }
  if (status === 'skipped') return skippedBuild(buildId)
  return awaitBuild(deps, indexName, buildId, controllerNodeId)
}
