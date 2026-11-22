import { ErrorCodes, NarsilError } from '../../../errors'
import { LOST_COPY_RETRY_MS } from '../../cluster/constants'
import { type CopyScan, type CopyScanDeps, type MissingCopy, scanForMissingCopies } from './scan'

export interface LostCopyWaitDeps extends CopyScanDeps {
  settleUnreadable(): Promise<void>
  standForElection(): Promise<void>
  onError(error: unknown): void
}

function stoppedWaiting(nodeId: string): NarsilError {
  return new NarsilError(
    ErrorCodes.NODE_NOT_JOINED,
    `Node '${nodeId}' shut down before it registered, while it checked the copies that the cluster assigns to it`,
    { nodeId },
  )
}

function untilStopped<T>(work: Promise<T>, signal: AbortSignal, nodeId: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const stop = () => reject(stoppedWaiting(nodeId))
    if (signal.aborted) stop()
    signal.addEventListener('abort', stop, { once: true })
    work.then(
      value => {
        signal.removeEventListener('abort', stop)
        resolve(value)
      },
      error => {
        signal.removeEventListener('abort', stop)
        reject(error)
      },
    )
  })
}

function pauseBeforeNextAttempt(signal: AbortSignal, nodeId: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const stop = () => {
      clearTimeout(timer)
      reject(stoppedWaiting(nodeId))
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', stop)
      resolve()
    }, LOST_COPY_RETRY_MS)
    if (signal.aborted) stop()
    else signal.addEventListener('abort', stop, { once: true })
  })
}

function missingCopyError(nodeId: string, copy: MissingCopy): NarsilError {
  const { indexName, partitionId } = copy
  return new NarsilError(
    ErrorCodes.NODE_COPY_MISSING,
    `Node '${nodeId}' started without its copy of partition ${partitionId} of index '${indexName}', which the allocation table assigns to it, so it waits to register until the controller fails that copy over. Start the node on the directory that holds the copy where that directory still exists`,
    { indexName, partitionId, nodeId },
  )
}

function createWaitReporter(deps: LostCopyWaitDeps) {
  const reportedCopies = new Set<string>()
  let lastFailure: string | null = null

  function report(error: unknown): void {
    try {
      deps.onError(error)
    } catch (_) {}
  }

  return (scan: CopyScan): void => {
    for (const copy of scan.missing) {
      const key = JSON.stringify([copy.indexName, copy.indexUuid, copy.partitionId])
      if (reportedCopies.has(key)) continue
      reportedCopies.add(key)
      report(missingCopyError(deps.nodeId, copy))
    }
    if (scan.failure === null) {
      lastFailure = null
      return
    }
    const failure = String(scan.failure.error)
    if (failure !== lastFailure) report(scan.failure.error)
    lastFailure = failure
  }
}

async function attempt(deps: LostCopyWaitDeps): Promise<{ scan: CopyScan; settleFailure: CopyScan['failure'] }> {
  let settleFailure: CopyScan['failure'] = null
  try {
    await deps.settleUnreadable()
  } catch (error) {
    settleFailure = { error }
  }
  return { scan: await scanForMissingCopies(deps), settleFailure }
}

export async function waitForLostCopies(deps: LostCopyWaitDeps, signal: AbortSignal): Promise<void> {
  const report = createWaitReporter(deps)
  for (;;) {
    const { scan, settleFailure } = await untilStopped(attempt(deps), signal, deps.nodeId)
    report({ missing: scan.missing, failure: scan.failure ?? settleFailure })
    if (scan.missing.length === 0 && scan.failure === null) return
    if (signal.aborted) throw stoppedWaiting(deps.nodeId)
    await deps.standForElection()
    await pauseBeforeNextAttempt(signal, deps.nodeId)
  }
}
