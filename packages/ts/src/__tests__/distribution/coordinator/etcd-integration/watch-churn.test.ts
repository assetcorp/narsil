import { randomUUID } from 'node:crypto'
import { setTimeout as sleep } from 'node:timers/promises'
import { Etcd3 } from 'etcd3'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createEtcdCoordinator } from '../../../../distribution/coordinator'
import {
  type EtcdContainerHandle,
  eventually,
  MANAGED_ETCD_ENDPOINT,
  makeNodeRegistration,
  runDocker,
  startEtcdContainer,
  stopEtcdContainer,
  waitForEtcdReady,
} from './fixtures'
import { startLinkProxy } from './link-proxy'

const CHURN_ROUNDS = 40
const WATCHES_PER_ROUND = 8
const LINK_CUT_EVERY_ROUNDS = 10
const LINK_DOWN_MS = 300
const WATCHES_OPENING_AT_SHUTDOWN = 16
const WATCH_OPENING_STAGGER_MS = 2
const QUIET_AFTER_SHUTDOWN_MS = 1_500
const RECOVERY_BUDGET_MS = 30_000
const UNREADABLE_REGISTRATION_WRITES = 3

interface EscapeRecorder {
  escaped: unknown[]
  stop(): void
}

function recordEscapes(): EscapeRecorder {
  const escaped: unknown[] = []
  const record = (reason: unknown): void => {
    escaped.push(reason)
  }
  process.on('unhandledRejection', record)
  process.on('uncaughtException', record)
  return {
    escaped,
    stop() {
      process.off('unhandledRejection', record)
      process.off('uncaughtException', record)
    },
  }
}

function describeEscapes(escaped: unknown[]): string[] {
  return escaped.map(reason => (reason instanceof Error ? `${reason.stack}` : String(reason)))
}

describe('an etcd coordinator whose watches open, stop, reconnect, and shut down at once', () => {
  let container: EtcdContainerHandle | null = null

  function requireEndpoint(): string {
    if (container === null) throw new Error('etcd is not available')
    return container.endpoint
  }

  beforeAll(async () => {
    if (MANAGED_ETCD_ENDPOINT !== null) {
      container = { endpoint: MANAGED_ETCD_ENDPOINT, name: null }
      await waitForEtcdReady(MANAGED_ETCD_ENDPOINT)
      return
    }
    await runDocker(['version'])
    container = await startEtcdContainer()
  }, 90_000)

  afterAll(async () => {
    await stopEtcdContainer(container?.name ?? null)
    container = null
  }, 30_000)

  it('lets no watch failure escape, reports every change, and settles every watch before shutdown returns', async () => {
    const endpoint = requireEndpoint()
    const keyPrefix = `_narsil_watch_churn_${randomUUID()}`
    const proxy = await startLinkProxy(new URL(endpoint))
    const watching = await createEtcdCoordinator({ endpoints: [proxy.endpoint], keyPrefix })
    const writer = await createEtcdCoordinator({ endpoints: [endpoint], keyPrefix })
    const escapes = recordEscapes()
    let shutDown = false
    let eventsAfterShutdown = 0
    const countLateEvent = (): void => {
      if (shutDown) eventsAfterShutdown += 1
    }

    try {
      let held: Array<() => void> = []
      for (let round = 0; round < CHURN_ROUNDS; round++) {
        const joinedBy = Array.from({ length: WATCHES_PER_ROUND }, () => new Set<string>())
        const opening = Promise.allSettled(
          joinedBy.map(joined =>
            watching.watchNodes(event => {
              countLateEvent()
              if (event.type === 'node_joined') joined.add(event.nodeId)
            }),
          ),
        )
        for (const stop of held) stop()
        held = []
        const outcomes = await opening
        const open = joinedBy.filter((_, position) => outcomes[position]?.status === 'fulfilled')
        for (const outcome of outcomes) {
          if (outcome.status === 'fulfilled') held.push(outcome.value)
        }
        expect(open.length).toBe(WATCHES_PER_ROUND)

        if (round % LINK_CUT_EVERY_ROUNDS === LINK_CUT_EVERY_ROUNDS - 1) {
          proxy.cut()
          await sleep(LINK_DOWN_MS)
          proxy.restore()
        }
        const nodeId = `churn-node-${round}`
        await writer.registerNode(makeNodeRegistration({ nodeId }))
        await eventually(
          async () => expect(open.filter(joined => !joined.has(nodeId)).length).toBe(0),
          RECOVERY_BUDGET_MS,
          `a watch that opened in round ${round} never reported the node that joined after it`,
        )
      }
      for (const stop of held) stop()

      let settled = 0
      const opening: Array<Promise<PromiseSettledResult<() => void>>> = []
      for (let position = 0; position < WATCHES_OPENING_AT_SHUTDOWN; position++) {
        const watch = Promise.allSettled([watching.watchNodes(countLateEvent)])
        opening.push(
          watch.then(([outcome]) => {
            settled += 1
            return outcome
          }),
        )
        await sleep(WATCH_OPENING_STAGGER_MS)
      }
      await watching.shutdown()
      shutDown = true
      const settledAtShutdown = settled
      for (const outcome of await Promise.all(opening)) {
        if (outcome.status === 'fulfilled') expect(() => outcome.value()).not.toThrow()
      }

      await writer.registerNode(makeNodeRegistration({ nodeId: 'after-shutdown' }))
      await sleep(QUIET_AFTER_SHUTDOWN_MS)
      expect(eventsAfterShutdown).toBe(0)
      expect(describeEscapes(escapes.escaped)).toEqual([])
      expect(settledAtShutdown).toBe(WATCHES_OPENING_AT_SHUTDOWN)
    } finally {
      escapes.stop()
      await watching.shutdown()
      await writer.shutdown()
      await proxy.close()
    }
  }, 180_000)

  it('reports each unreadable node registration once and keeps reporting the nodes that join after it', async () => {
    const endpoint = requireEndpoint()
    const keyPrefix = `_narsil_watch_churn_${randomUUID()}`
    const watchErrors: Error[] = []
    const watching = await createEtcdCoordinator({
      endpoints: [endpoint],
      keyPrefix,
      onWatchError: error => watchErrors.push(error),
    })
    const writer = await createEtcdCoordinator({ endpoints: [endpoint], keyPrefix })
    const raw = new Etcd3({ hosts: [endpoint] })
    const escapes = recordEscapes()
    const joined = new Set<string>()

    try {
      const stop = await watching.watchNodes(event => {
        if (event.type === 'node_joined') joined.add(event.nodeId)
      })
      for (let write = 0; write < UNREADABLE_REGISTRATION_WRITES; write++) {
        await raw.put(`${keyPrefix}/nodes/unreadable-node`).value(Buffer.from([0xc1, write]))
        const nodeId = `readable-node-${write}`
        await writer.registerNode(makeNodeRegistration({ nodeId }))
        await eventually(
          async () => expect(joined.has(nodeId)).toBe(true),
          RECOVERY_BUDGET_MS,
          `the watch never reported ${nodeId}, which joined after an unreadable registration`,
        )
      }
      await sleep(QUIET_AFTER_SHUTDOWN_MS)
      stop()

      expect(watchErrors.length).toBe(UNREADABLE_REGISTRATION_WRITES)
      expect(describeEscapes(escapes.escaped)).toEqual([])
    } finally {
      escapes.stop()
      raw.close()
      await watching.shutdown()
      await writer.shutdown()
    }
  }, 120_000)
})
