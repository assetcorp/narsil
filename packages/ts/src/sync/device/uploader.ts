import { RETRY_MAX_DELAY_MS, UPLOAD_BATCH_WRITES, UPLOAD_RETRY_DELAY_MS } from './constants'
import { backoffDelayMs, type DeviceContext } from './context'
import { putLocally, removeLocally } from './local-writes'
import type { Progress } from './progress'
import type { Session, SessionState } from './session'
import type { QueuedWrite, UploadOutcome } from './types'
import { sendThroughBackend, sendThroughServer, type UploadBatch } from './upload'

export interface Uploader {
  kick(): void
  idle(): Promise<void>
}

type RefusedOutcome = Extract<UploadOutcome, { accepted: false }>

export function createUploader(
  context: DeviceContext,
  progress: Progress,
  session: Session,
  state: SessionState,
): Uploader {
  const { engine, indexName, store, queue, work, client } = context
  let running: Promise<void> | null = null
  let again = false

  async function serverCopyOf(write: QueuedWrite, outcome: RefusedOutcome) {
    if (outcome.serverDocument !== undefined) return outcome.serverDocument
    return (await client.get(indexName, write.documentId, await context.requestOptions())) ?? null
  }

  async function refuse(write: QueuedWrite, outcome: RefusedOutcome): Promise<void> {
    const serverDocument = await serverCopyOf(write, outcome)
    await work.run(async () => {
      const covered = queue.coveredBy(write)
      if (!queue.hasLaterWrite(write)) {
        if (serverDocument === null) await removeLocally(engine, indexName, write.documentId)
        else await putLocally(engine, indexName, write.documentId, serverDocument)
      }
      await store.removeWrites(covered)
      queue.remove(covered)
      progress.forgetDeferred(write.documentId)
    })
    try {
      context.options.onRefusedWrite?.({ write, error: outcome.error, serverDocument })
    } catch (error) {
      context.report(error)
    }
  }

  async function settle(batch: readonly QueuedWrite[], result: UploadBatch): Promise<unknown> {
    let failure = result.failure
    for (let at = 0; at < result.outcomes.length; at++) {
      const write = batch[at]
      const outcome = result.outcomes[at]
      if (write === undefined || outcome === undefined) break
      if (outcome.accepted) {
        const covered = queue.coveredBy(write)
        queue.markUploaded(covered)
        state.pendingHold.push(...covered)
        progress.forgetDeferred(write.documentId)
        continue
      }
      try {
        await refuse(write, outcome)
      } catch (error) {
        failure ??= error
        break
      }
    }
    return failure
  }

  async function drain(): Promise<void> {
    let failures = 0
    while (!context.stopped()) {
      again = false
      const batch = queue.latestAwaitingUpload().slice(0, UPLOAD_BATCH_WRITES)
      if (batch.length === 0) return
      const upload = context.options.upload
      const result =
        upload === undefined
          ? await sendThroughServer(client, indexName, batch, context.requestOptions)
          : await sendThroughBackend(upload, batch)
      const failure = await settle(batch, result)
      session.startHold()
      context.changes.notify()
      if (failure === null || failure === undefined) {
        failures = 0
        continue
      }
      context.report(failure)
      await context.pause(backoffDelayMs(failures, UPLOAD_RETRY_DELAY_MS, RETRY_MAX_DELAY_MS))
      failures += 1
    }
  }

  function kick(): void {
    if (context.stopped()) return
    if (running !== null) {
      again = true
      return
    }
    running = drain()
      .catch(context.report)
      .finally(() => {
        running = null
        if (again) kick()
      })
  }

  return {
    kick,
    idle: () => running ?? Promise.resolve(),
  }
}
