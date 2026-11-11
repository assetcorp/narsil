import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { Duplex } from 'node:stream'
import { encode } from '@msgpack/msgpack'
import { describe, expect, it } from 'vitest'
import { createNarsilClient } from '../../client'

const WEBSOCKET_ACCEPT_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'
const CHANGES_SUBPROTOCOL = 'narsil.changes.v1'
const FINAL_BINARY_FRAME = 0x82
const SIXTEEN_BIT_LENGTH = 126
const SIXTY_FOUR_BIT_LENGTH = 127
const NESTED_MAPS = 20_000

function binaryFrame(payload: Uint8Array): Buffer {
  const length = payload.byteLength
  if (length < SIXTEEN_BIT_LENGTH) return Buffer.concat([Buffer.from([FINAL_BINARY_FRAME, length]), payload])
  if (length < 65_536) {
    const header = Buffer.from([FINAL_BINARY_FRAME, SIXTEEN_BIT_LENGTH, 0, 0])
    header.writeUInt16BE(length, 2)
    return Buffer.concat([header, payload])
  }
  const header = Buffer.alloc(10)
  header[0] = FINAL_BINARY_FRAME
  header[1] = SIXTY_FOUR_BIT_LENGTH
  header.writeBigUInt64BE(BigInt(length), 2)
  return Buffer.concat([header, payload])
}

async function eventsFromServer(frames: Uint8Array[]): Promise<unknown[]> {
  const sockets: Duplex[] = []
  const server = createServer()
  server.on('upgrade', (request, socket) => {
    sockets.push(socket)
    const key = request.headers['sec-websocket-key'] ?? ''
    const accept = createHash('sha1').update(`${key}${WEBSOCKET_ACCEPT_GUID}`).digest('base64')
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${accept}\r\nSec-WebSocket-Protocol: ${CHANGES_SUBPROTOCOL}\r\n\r\n`,
    )
    socket.once('data', () => {
      for (const frame of frames) socket.write(binaryFrame(frame))
    })
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const { port } = server.address() as AddressInfo
  const subscription = createNarsilClient({ url: `http://127.0.0.1:${port}` }).followChanges('shop')
  try {
    const events: unknown[] = []
    for await (const event of subscription) events.push(event)
    return events
  } finally {
    subscription.close()
    for (const socket of sockets) socket.destroy()
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
}

function deeplyNestedChange(): Uint8Array {
  const nested = Buffer.alloc(NESTED_MAPS * 3)
  for (let at = 0; at < NESTED_MAPS; at++) nested.set([0x81, 0xa1, 0x6e], at * 3)
  return Buffer.concat([
    Buffer.from([0x84]),
    encode('type'),
    encode('changes'),
    encode('partitionId'),
    encode(0),
    encode('scannedSeqNo'),
    encode(1),
    encode('changes'),
    Buffer.from([0x91, 0x84]),
    encode('type'),
    encode('put'),
    encode('seqNo'),
    encode(1),
    encode('documentId'),
    encode('lamp'),
    encode('document'),
    nested,
    encode({ leaf: 1 }),
  ])
}

describe('the change feed client facing a hostile server', () => {
  it('refuses a document that nests 20,000 maps deep with CLIENT_INVALID_RESPONSE', async () => {
    const subscribed = encode({
      type: 'subscribed',
      epoch: 'a'.repeat(32),
      partitionCount: 1,
      positions: [{ partitionId: 0, seqNo: 0 }],
      heads: [{ partitionId: 0, seqNo: 1 }],
      bytesBehind: 0,
      windowBytes: 1_024,
      previousDocument: false,
      vectorFields: [],
    })
    await expect(eventsFromServer([subscribed, deeplyNestedChange()])).rejects.toMatchObject({
      code: 'CLIENT_INVALID_RESPONSE',
    })
  })
})
