import { ClientErrorCodes, NarsilError } from '../../errors'
import type { SyncSettings } from '../protocol'
import { DEFAULT_REPLAY_LIMIT_OF_SNAPSHOT } from './constants'
import type { DeviceContext } from './context'
import { type FeedConnection, openFeedConnection } from './feed'
import { type FeedMessage, positionsOf } from './messages'
import type { Progress } from './progress'

const MAX_CHECKPOINT_ID = 0xffff_ffff

export type SnapshotNeed = 'required' | 'behind'

export interface SessionState {
  subscribed: boolean
  needsSnapshot: SnapshotNeed | null
  replayAnyway: boolean
  pendingHold: number[]
  settings: SyncSettings | null
}

interface Hold {
  checkpointId: number
  heads: number[] | null
  sequences: number[]
}

export interface Session {
  connect(feedUrl: string): Promise<{ code: number; subscribed: boolean }>
  close(reason: string): void
  startHold(): void
  requestHeads(): Promise<number[] | null>
  holding(): boolean
  forgetAppliedSettings(): void
}

function settingsKey(settings: SyncSettings): string {
  return JSON.stringify({ bm25: settings.bm25 ?? null, synonyms: settings.synonyms ?? [] })
}

export function createSession(context: DeviceContext, progress: Progress, state: SessionState): Session {
  const { engine, indexName } = context
  let feed: FeedConnection | null = null
  let generation = 0
  let incoming: Promise<void> = Promise.resolve()
  let hold: Hold | null = null
  let nextCheckpointId = 1
  let appliedSettings: string | null = null
  const waiters = new Map<number, (heads: number[] | null) => void>()
  let subscribedOnce = false

  function sendCheckpoint(onHeads: (heads: number[] | null) => void): void {
    const id = nextCheckpointId
    nextCheckpointId = id >= MAX_CHECKPOINT_ID ? 1 : id + 1
    waiters.set(id, onHeads)
    feed?.send({ type: 'checkpoint', id })
  }

  async function applySettings(settings: SyncSettings): Promise<void> {
    state.settings = settings
    const key = settingsKey(settings)
    if (key === appliedSettings) return
    await context.work.run(async () => {
      await engine.updateBM25(indexName, settings.bm25 ?? {})
      await engine.updateSynonyms(indexName, settings.synonyms ?? [])
    })
    appliedSettings = key
  }

  async function completeHold(): Promise<void> {
    const done = hold
    if (done === null || done.heads === null || !progress.reached(done.heads)) return
    hold = null
    await progress.settleUploaded(done.sequences)
    context.changes.notify()
    startHold()
  }

  function startHold(): void {
    if (hold !== null || !state.subscribed || feed === null || state.pendingHold.length === 0) return
    const started: Hold = { checkpointId: 0, heads: null, sequences: state.pendingHold }
    state.pendingHold = []
    hold = started
    sendCheckpoint(heads => {
      if (hold !== started || heads === null) return
      started.heads = heads
      completeHold().catch(context.report)
    })
  }

  function refuse(detail: string): never {
    throw new NarsilError(ClientErrorCodes.CLIENT_INVALID_RESPONSE, `The sync feed broke its protocol: ${detail}`)
  }

  async function handle(message: FeedMessage): Promise<void> {
    const position = progress.position()
    if (position === null) refuse('the device holds no copy')
    switch (message.type) {
      case 'subscribed': {
        if (message.epoch !== position.epoch || message.partitionCount !== position.seqNos.length) {
          state.needsSnapshot = 'required'
          feed?.close('epoch')
          return
        }
        const behind = message.snapshotBytes > 0 && message.bytesBehind > replayLimit() * message.snapshotBytes
        if (behind && !state.replayAnyway) {
          state.needsSnapshot = 'behind'
          feed?.close('behind')
          return
        }
        state.replayAnyway = false
        progress.setFlushThreshold(message.windowBytes)
        await applySettings(message.settings)
        state.subscribed = true
        subscribedOnce = true
        context.changes.notify()
        startHold()
        return
      }
      case 'entries':
        if (!state.subscribed) refuse('entries arrived before subscribed')
        if (message.partitionId >= progress.received().length) refuse('entries name a partition that the index lacks')
        await progress.keep(message.partitionId, message.entries)
        await completeHold()
        context.changes.notify()
        return
      case 'settings':
        await applySettings(message.settings)
        return
      case 'checkpoint': {
        if (message.heads.length !== progress.received().length) refuse('heads name another partition count')
        const waiter = waiters.get(message.id)
        waiters.delete(message.id)
        waiter?.(message.heads)
        return
      }
      case 'resync':
        state.needsSnapshot = 'required'
        return
    }
  }

  function replayLimit(): number {
    return context.options.replayLimitOfSnapshot ?? DEFAULT_REPLAY_LIMIT_OF_SNAPSHOT
  }

  function closed(): void {
    feed = null
    generation += 1
    state.subscribed = false
    progress.setAcknowledge(null)
    if (hold !== null) {
      state.pendingHold = [...hold.sequences, ...state.pendingHold]
      hold = null
    }
    for (const waiter of waiters.values()) waiter(null)
    waiters.clear()
    context.changes.notify()
  }

  return {
    async connect(feedUrl) {
      await incoming
      const position = progress.position()
      if (position === null || context.stopped()) return { code: 0, subscribed: false }
      let credential: string | null
      try {
        credential = await context.credential()
      } catch (error) {
        context.report(error)
        return { code: 0, subscribed: false }
      }
      if (context.stopped()) return { code: 0, subscribed: false }
      const mine = generation
      subscribedOnce = false
      const code = await new Promise<number>(resolve => {
        try {
          feed = openFeedConnection(feedUrl, credential, {
            onOpen() {
              progress.setAcknowledge(seqNos => feed?.send({ type: 'ack', positions: positionsOf(seqNos) }))
              feed?.send({ type: 'subscribe', epoch: position.epoch, positions: positionsOf(progress.received()) })
            },
            onMessage(message) {
              incoming = incoming
                .then(() => (generation === mine ? handle(message) : undefined))
                .catch(error => {
                  context.report(error)
                  if (generation === mine) feed?.close('device error')
                })
            },
            onFailure: context.report,
            onClose(code) {
              closed()
              resolve(code)
            },
          })
        } catch (error) {
          context.report(error)
          resolve(0)
        }
      })
      return { code, subscribed: subscribedOnce }
    },

    close(reason) {
      feed?.close(reason)
    },

    startHold,

    requestHeads() {
      if (feed === null || !state.subscribed) return Promise.resolve(null)
      return new Promise(resolve => sendCheckpoint(resolve))
    },

    holding: () => hold !== null,

    forgetAppliedSettings() {
      appliedSettings = null
    },
  }
}
