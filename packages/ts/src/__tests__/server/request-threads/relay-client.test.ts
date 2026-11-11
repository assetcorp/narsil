import { MessageChannel, type MessagePort } from 'node:worker_threads'
import { describe, expect, it } from 'vitest'
import { ServerErrorCodes } from '../../../server/errors'
import type { RouteContext } from '../../../server/request'
import { createCapturingResponse } from '../../../server/request-threads/captured-response'
import { createRelayClient } from '../../../server/request-threads/relay-client'

const CONTEXT = { method: 'get', path: '/indexes', headers: {}, remoteAddress: '127.0.0.1' }
function routeContext(rawBody: Buffer, port: MessagePort): RouteContext {
  const captured = createCapturingResponse('127.0.0.1', 0, (part, moved) => port.postMessage(part, moved))
  return {
    res: captured.sink,
    params: ['products'],
    query: new URLSearchParams(),
    contentType: 'application/x-ndjson',
    rawBody,
    spooledBody: null,
    bodyRefusal: null,
    abort: captured.abort,
    hookContext: null,
    requestHeaders: {},
  }
}

function answerWithTheBodyReceived(port: MessagePort): Promise<Uint8Array> {
  return new Promise(resolve => {
    port.on('message', (message: { requestId: number; rawBody: Uint8Array }) => {
      resolve(message.rawBody)
      port.postMessage({
        type: 'response',
        requestId: message.requestId,
        status: 200,
        headers: [],
        body: new Uint8Array(0),
      })
    })
  })
}

describe('the relay client when it passes a request body to the main thread', () => {
  it('moves a body that owns its memory, so the request thread keeps no copy', async () => {
    const { port1, port2 } = new MessageChannel()
    const relay = createRelayClient(port1, 1000)
    const received = answerWithTheBodyReceived(port2)
    const body = Buffer.allocUnsafeSlow(64 * 1024).fill(7)
    const memory = body.buffer

    await relay.request('importNdjson', routeContext(body, port1))

    expect(memory.byteLength).toBe(0)
    const arrived = await received
    expect(arrived.byteLength).toBe(64 * 1024)
    expect(arrived.every(byte => byte === 7)).toBe(true)
    relay.close()
    port2.close()
  })

  it('copies a body that shares its memory with other buffers', async () => {
    const { port1, port2 } = new MessageChannel()
    const relay = createRelayClient(port1, 1000)
    const received = answerWithTheBodyReceived(port2)
    const shared = Buffer.allocUnsafeSlow(32).fill(1)
    const body = shared.subarray(8, 16).fill(9)

    await relay.request('importNdjson', routeContext(body, port1))

    expect(shared.buffer.byteLength).toBe(32)
    expect([...(await received)]).toEqual([9, 9, 9, 9, 9, 9, 9, 9])
    relay.close()
    port2.close()
  })
})

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
