import { randomBytes } from 'node:crypto'
import { connect, type Socket } from 'node:net'
import { SUBPROTOCOL } from './fixtures'

const HEADER_END = Buffer.from('\r\n\r\n')
const CLOSE_OPCODE = 0x8
const ENDED_WITHOUT_CLOSE_FRAME = 1006
const CLOSE_FRAME_WITHOUT_CODE = 1005

export interface BodyRequest {
  method: string
  path: string
  token: string
  body: string
}

export interface FeedOnReusedConnection {
  requestStatus: number
  upgradeStatus: number
  closeCode: number
}

interface ByteReader {
  headerBlock(): Promise<string>
  exactly(length: number): Promise<Buffer>
}

class ConnectionEnded extends Error {}

function readerOf(socket: Socket, deadline: number): ByteReader {
  let pending = Buffer.alloc(0)
  let ended = false
  let wake: (() => void) | null = null
  const notify = (): void => {
    const waiting = wake
    wake = null
    waiting?.()
  }
  socket.on('data', (chunk: Buffer) => {
    pending = Buffer.concat([pending, chunk])
    notify()
  })
  socket.on('close', () => {
    ended = true
    notify()
  })
  socket.on('error', () => {
    ended = true
    notify()
  })

  async function until(ready: () => boolean): Promise<void> {
    while (!ready()) {
      if (ended) throw new ConnectionEnded('The server ended the connection')
      const remaining = deadline - Date.now()
      if (remaining <= 0) throw new Error('The server sent nothing before the deadline')
      await new Promise<void>(resolve => {
        const timer = setTimeout(resolve, remaining)
        wake = () => {
          clearTimeout(timer)
          resolve()
        }
      })
    }
  }

  return {
    async headerBlock() {
      await until(() => pending.indexOf(HEADER_END) >= 0)
      const at = pending.indexOf(HEADER_END)
      const block = pending.subarray(0, at).toString('latin1')
      pending = pending.subarray(at + HEADER_END.length)
      return block
    },
    async exactly(length) {
      await until(() => pending.length >= length)
      const taken = pending.subarray(0, length)
      pending = pending.subarray(length)
      return taken
    },
  }
}

function statusOf(block: string): number {
  const match = /^HTTP\/1\.1 (\d{3})/.exec(block)
  if (match === null) throw new Error(`The server answered without a status line: ${block.slice(0, 80)}`)
  return Number(match[1])
}

function contentLengthOf(block: string): number {
  const match = /\r\ncontent-length: *(\d+)/i.exec(block)
  if (match === null) throw new Error('The server answered without a Content-Length')
  return Number(match[1])
}

async function closeCodeOf(reader: ByteReader): Promise<number> {
  try {
    for (;;) {
      const head = await reader.exactly(2)
      const opcode = head[0] & 0x0f
      let length = head[1] & 0x7f
      if (length === 126) length = (await reader.exactly(2)).readUInt16BE(0)
      else if (length === 127) length = Number((await reader.exactly(8)).readBigUInt64BE(0))
      const payload = await reader.exactly(length)
      if (opcode !== CLOSE_OPCODE) continue
      return payload.length >= 2 ? payload.readUInt16BE(0) : CLOSE_FRAME_WITHOUT_CODE
    }
  } catch (err) {
    if (err instanceof ConnectionEnded) return ENDED_WITHOUT_CLOSE_FRAME
    throw err
  }
}

export async function feedOnReusedConnection(
  base: string,
  request: BodyRequest,
  feedPath: string,
  feedToken: string,
  timeoutMs: number,
): Promise<FeedOnReusedConnection> {
  const url = new URL(base)
  const socket = connect({ host: url.hostname, port: Number(url.port) })
  const reader = readerOf(socket, Date.now() + timeoutMs)
  const host = `${url.hostname}:${url.port}`
  try {
    socket.write(
      `${request.method} ${request.path} HTTP/1.1\r\nHost: ${host}\r\nAuthorization: Bearer ${request.token}\r\n` +
        `Content-Type: application/json\r\nContent-Length: ${Buffer.byteLength(request.body)}\r\n\r\n${request.body}`,
    )
    const answer = await reader.headerBlock()
    await reader.exactly(contentLengthOf(answer))
    socket.write(
      `GET ${feedPath} HTTP/1.1\r\nHost: ${host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
        `Sec-WebSocket-Version: 13\r\nSec-WebSocket-Key: ${randomBytes(16).toString('base64')}\r\n` +
        `Sec-WebSocket-Protocol: ${SUBPROTOCOL}, ${feedToken}\r\n\r\n`,
    )
    const upgrade = await reader.headerBlock()
    return { requestStatus: statusOf(answer), upgradeStatus: statusOf(upgrade), closeCode: await closeCodeOf(reader) }
  } finally {
    socket.destroy()
  }
}
