import { decode, encode } from '@msgpack/msgpack'
import { generateId } from '../../../../core/id-generator'
import { describeError, ErrorCodes, NarsilError } from '../../../../errors'
import type { ClusterCoordinator } from '../../../coordinator/types'
import { isRecord } from '../../../payload-guards'
import type { RebuildAnalysisPayload } from '../../../transport/cluster-payloads'
import { ClusterMessageTypes, type TransportMessage } from '../../../transport/types'
import { metadataPublishingAnalysis, metadataWithAnalysisFailure } from '../../analysis-metadata'
import { ANALYSIS_CHANGE_POLL_INTERVAL_MS, ANALYSIS_CHANGE_RETRY_MS, ANALYSIS_REBUILD_RESEND_MS } from '../../constants'
import { type IndexMetadataSnapshot, indexConfigKey, readIndexMetadataSnapshot } from '../../index-metadata'
import type { AnalysisFailure, PendingClusterAnalysis } from '../../index-settings'
import { pause } from '../../rebalance/pause'
import type { EventLoopState } from './state'

export interface AnalysisDriverContext {
  state: EventLoopState
  coordinator: ClusterCoordinator
  nodeId: string
  isActive: () => boolean
  onError?: (indexName: string, error: unknown) => void
}

interface ChangeProgress {
  changeId: string
  answered: Set<string>
  asking: Set<string>
  refusal: AnalysisFailure | null
}

const REFUSALS_THAT_FAIL_A_CHANGE: ReadonlySet<string> = new Set([
  ErrorCodes.ANALYSIS_REBUILD_MEMORY_EXCEEDED,
  ErrorCodes.LANGUAGE_NOT_SUPPORTED,
  ErrorCodes.CONFIG_INVALID,
])

async function registeredHolders(
  coordinator: ClusterCoordinator,
  indexName: string,
): Promise<Map<string, string[]> | null> {
  const table = await coordinator.getAllocation(indexName)
  if (table === null) return null
  const registered = new Map((await coordinator.listNodes()).map(node => [node.nodeId, node.address]))
  const holders = new Map<string, string[]>()
  const note = (nodeId: string | null): void => {
    if (nodeId === null) return
    const address = registered.get(nodeId)
    if (address === undefined) return
    holders.set(nodeId, address.length === 0 || address === nodeId ? [nodeId] : [address, nodeId])
  }
  for (const assignment of table.assignments.values()) {
    note(assignment.primary)
    for (const replica of assignment.replicas) note(replica)
    for (const replica of assignment.removingReplicas ?? []) note(replica)
  }
  return holders
}

async function askOneTarget(
  ctx: AnalysisDriverContext,
  target: string,
  message: TransportMessage,
): Promise<TransportMessage> {
  const transport = ctx.state.transport
  if (transport === null) throw new NarsilError(ErrorCodes.NODE_NOT_CONTROLLER, 'The controller has no transport')
  return transport.send(target, message)
}

async function sendRebuild(
  ctx: AnalysisDriverContext,
  targets: string[],
  payload: RebuildAnalysisPayload,
): Promise<void> {
  const message: TransportMessage = {
    type: ClusterMessageTypes.REBUILD_ANALYSIS,
    sourceId: ctx.nodeId,
    requestId: generateId(),
    payload: encode(payload),
  }
  let lastError: unknown = new NarsilError(ErrorCodes.QUERY_NO_ACTIVE_REPLICA, 'The node has no address')
  for (const target of targets) {
    let response: TransportMessage
    try {
      response = await askOneTarget(ctx, target, message)
    } catch (error) {
      lastError = error
      continue
    }
    const decoded: unknown = decode(response.payload)
    if (!response.type.endsWith('.error') && !(isRecord(decoded) && decoded.error === true)) return
    const reply = isRecord(decoded) ? decoded : {}
    throw new NarsilError(
      typeof reply.code === 'string' ? reply.code : ErrorCodes.QUERY_ROUTING_FAILED,
      typeof reply.message === 'string' ? reply.message : 'The node refused an analysis rebuild',
    )
  }
  throw lastError
}

function askHolder(
  ctx: AnalysisDriverContext,
  progress: ChangeProgress,
  holder: string,
  targets: string[],
  payload: RebuildAnalysisPayload,
): void {
  progress.asking.add(holder)
  const resend = new Promise<'resend'>(resolve => {
    const timer = setTimeout(() => resolve('resend'), ANALYSIS_REBUILD_RESEND_MS)
    if (typeof timer === 'object' && 'unref' in timer) timer.unref()
  })
  const asked = sendRebuild(ctx, targets, payload).then(
    () => {
      progress.answered.add(holder)
    },
    (error: unknown) => {
      if (error instanceof NarsilError && REFUSALS_THAT_FAIL_A_CHANGE.has(error.code)) {
        progress.refusal = {
          changeId: progress.changeId,
          code: error.code,
          message: describeError(error),
          nodeId: holder,
        }
      }
    },
  )
  void Promise.race([asked, resend]).finally(() => progress.asking.delete(holder))
}

async function stepChange(
  ctx: AnalysisDriverContext,
  indexName: string,
  snapshot: IndexMetadataSnapshot,
  pending: PendingClusterAnalysis,
  progress: ChangeProgress,
): Promise<void> {
  const key = indexConfigKey(indexName)
  if (progress.refusal !== null) {
    await ctx.coordinator.compareAndSet(key, snapshot.bytes, metadataWithAnalysisFailure(snapshot, progress.refusal))
    return
  }
  const holders = (await registeredHolders(ctx.coordinator, indexName)) ?? new Map<string, string[]>()
  const payload: RebuildAnalysisPayload = {
    indexName,
    indexUuid: snapshot.record.indexUuid,
    generation: pending.generation,
  }
  let waiting = false
  for (const [holder, targets] of holders) {
    if (progress.answered.has(holder)) continue
    waiting = true
    if (!progress.asking.has(holder)) askHolder(ctx, progress, holder, targets, payload)
  }
  if (!waiting) {
    await ctx.coordinator.compareAndSet(key, snapshot.bytes, metadataPublishingAnalysis(snapshot, pending))
    return
  }
  await pause(ANALYSIS_CHANGE_POLL_INTERVAL_MS)
}

function progressOf(changeId: string): ChangeProgress {
  return { changeId, answered: new Set(), asking: new Set(), refusal: null }
}

async function driveChanges(ctx: AnalysisDriverContext, indexName: string): Promise<void> {
  let progress = progressOf('')
  while (ctx.isActive()) {
    const snapshot = await readIndexMetadataSnapshot(ctx.coordinator, indexName)
    const pending = snapshot?.settings?.pendingAnalysis
    if (snapshot === null || pending === undefined) return
    if (progress.changeId !== pending.changeId) progress = progressOf(pending.changeId)
    await stepChange(ctx, indexName, snapshot, pending, progress)
  }
}

export function startAnalysisDriver(ctx: AnalysisDriverContext, indexName: string): void {
  const drivers = ctx.state.analysisDrivers
  const running = drivers.get(indexName)
  if (running !== undefined) {
    running.again = true
    return
  }
  const driver = { again: false }
  drivers.set(indexName, driver)
  const drive = async (): Promise<void> => {
    do {
      driver.again = false
      await driveChanges(ctx, indexName).catch(async (error: unknown) => {
        ctx.onError?.(indexName, error)
        driver.again = true
        await pause(ANALYSIS_CHANGE_RETRY_MS)
      })
    } while (driver.again && ctx.isActive())
    if (drivers.get(indexName) === driver) drivers.delete(indexName)
  }
  void drive()
}

export async function resumeAnalysisDrivers(ctx: AnalysisDriverContext): Promise<void> {
  for (const indexName of await ctx.coordinator.listSchemas()) {
    const snapshot = await readIndexMetadataSnapshot(ctx.coordinator, indexName)
    if (snapshot?.settings?.pendingAnalysis !== undefined) startAnalysisDriver(ctx, indexName)
  }
}
