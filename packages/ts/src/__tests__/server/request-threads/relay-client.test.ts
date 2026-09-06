import { MessageChannel } from 'node:worker_threads'
import { describe, expect, it } from 'vitest'
import { ServerErrorCodes } from '../../../server/errors'
import { createRelayClient } from '../../../server/request-threads/relay-client'

const CONTEXT = { method: 'get', path: '/indexes', headers: {}, remoteAddress: '127.0.0.1' }

describe('the relay client when its port to the main thread has closed', () => {
  it('denies an authorisation with a service-unavailable status', async () => {
    const { port1, port2 } = new MessageChannel()
    const relay = createRelayClient(port1, 1000)
    relay.close()
    port2.close()

    const authorization = await relay.authorize(CONTEXT)

    expect(authorization).toEqual({
      allowed: false,
      denial: { status: 503, code: ServerErrorCodes.INTERNAL_ERROR, message: 'The server is shutting down' },
    })
  })

  it('passes a denial the main thread returns through unchanged', async () => {
    const { port1, port2 } = new MessageChannel()
    const relay = createRelayClient(port1, 1000)
    port2.on('message', (message: { requestId: number }) => {
      port2.postMessage({
        type: 'authorized',
        requestId: message.requestId,
        denial: { status: 401, code: 'UNAUTHORIZED', message: 'No key' },
        hookError: false,
      })
    })

    const authorization = await relay.authorize(CONTEXT)

    expect(authorization).toEqual({
      allowed: false,
      denial: { status: 401, code: 'UNAUTHORIZED', message: 'No key' },
    })
    relay.close()
    port2.close()
  })
})
