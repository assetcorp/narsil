import { describe, expect, it } from 'vitest'
import { createTlsPair, type ListenHandler, makeMessage } from '../tcp-tls/fixtures'

const PAYLOAD_BYTES = 100
const WARM_UP_EXCHANGES = 10
const MEASURED_EXCHANGES = 100
const DELAYED_ACKNOWLEDGEMENT_MS = 40
const EXCHANGES_FINISH_WITHIN_MS = (MEASURED_EXCHANGES * DELAYED_ACKNOWLEDGEMENT_MS) / 2
const TEST_TIMEOUT_MS = 30_000
const CONNECTING_REQUEST_ID = 'connect'

function answerOnceBothRequestsArrive(): ListenHandler {
  let releaseFirst: (() => void) | undefined
  return async (message, respond) => {
    if (message.requestId === CONNECTING_REQUEST_ID) {
      respond({ ...message, sourceId: 'receiver' })
      return
    }
    if (releaseFirst === undefined) {
      await new Promise<void>(resolve => {
        releaseFirst = resolve
      })
    } else {
      releaseFirst()
      releaseFirst = undefined
    }
    respond({ ...message, sourceId: 'receiver' })
  }
}

describe('short frames on a TCP connection', () => {
  it(
    'reach the peer without waiting for a delayed acknowledgement',
    async () => {
      const pair = await createTlsPair(answerOnceBothRequestsArrive(), undefined, undefined)
      const target = `127.0.0.1:${pair.port}`

      async function exchange(at: number): Promise<void> {
        const sent = [0, 1].map(position => new Uint8Array(PAYLOAD_BYTES).fill((at * 2 + position) % 256))
        const answers = await Promise.all(
          sent.map((payload, position) =>
            pair.client.send(target, makeMessage({ requestId: `short-${at}-${position}`, payload })),
          ),
        )
        expect(answers.map(answer => answer.payload)).toEqual(sent)
      }

      try {
        await pair.client.send(target, makeMessage({ requestId: CONNECTING_REQUEST_ID }))
        for (let at = 0; at < WARM_UP_EXCHANGES; at += 1) await exchange(at)

        const startedAt = performance.now()
        for (let at = 0; at < MEASURED_EXCHANGES; at += 1) await exchange(WARM_UP_EXCHANGES + at)
        expect(performance.now() - startedAt).toBeLessThan(EXCHANGES_FINISH_WITHIN_MS)
      } finally {
        await pair.cleanup()
      }
    },
    TEST_TIMEOUT_MS,
  )
})
