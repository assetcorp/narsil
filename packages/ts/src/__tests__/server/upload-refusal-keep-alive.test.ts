import { connect, type Socket } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import type { ServerOptions } from '../../server'
import { postJson, startTestServer, type TestServer } from './helpers'

const LIMIT_BYTES = 1024 * 1024
const NEXT_ANSWER_TIMEOUT_MS = 3_000
const SPOOLED_UPLOAD_PATHS = ['/indexes/movies/restore', '/indexes/movies/import']
const ATTEMPTS = 8

function readOneResponse(socket: Socket): Promise<string> {
  return new Promise((resolve, reject) => {
    let received = ''
    const finish = (settle: () => void): void => {
      clearTimeout(timer)
      socket.off('data', onData)
      socket.off('close', onClose)
      settle()
    }
    const onData = (chunk: Buffer): void => {
      received += chunk.toString('latin1')
      const headerEnd = received.indexOf('\r\n\r\n')
      if (headerEnd === -1) return
      const length = Number(/content-length: (\d+)/i.exec(received)?.[1] ?? 0)
      if (received.length >= headerEnd + 4 + length) finish(() => resolve(received))
    }
    const onClose = (): void => finish(() => reject(new Error('The server closed the connection')))
    const timer = setTimeout(() => {
      finish(() => reject(new Error('The server stopped answering on the open connection')))
    }, NEXT_ANSWER_TIMEOUT_MS)
    socket.on('data', onData)
    socket.on('close', onClose)
  })
}

async function uploadThenAskAgain(port: number, path: string, bytes: number): Promise<[string, string]> {
  const socket = connect(port, '127.0.0.1')
  try {
    socket.on('error', () => undefined)
    await new Promise(resolve => socket.once('connect', resolve))
    const head = `POST ${path} HTTP/1.1\r\nHost: narsil.test\r\nContent-Length: ${bytes}\r\n\r\n`
    const answered = readOneResponse(socket)
    socket.write(Buffer.concat([Buffer.from(head), Buffer.alloc(bytes)]))
    const first = await answered
    const nextAnswered = readOneResponse(socket)
    socket.write('GET /livez HTTP/1.1\r\nHost: narsil.test\r\n\r\n')
    return [first, await nextAnswered]
  } finally {
    socket.destroy()
  }
}

describe('a connection after the server refuses an upload', () => {
  let server: TestServer

  async function start(options: Omit<ServerOptions, 'host' | 'port'>): Promise<void> {
    server = await startTestServer(options, { workers: { enabled: false } })
    await postJson(server.base, '/indexes', { name: 'movies', config: { schema: { title: 'string' } } })
  }

  afterEach(async () => {
    await server.stop()
  })

  for (const path of SPOOLED_UPLOAD_PATHS) {
    it(`answers the next request after ${path} refuses an oversized body`, async () => {
      await start({ limits: { maxRestoreBytes: LIMIT_BYTES } })
      for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
        const [first, next] = await uploadThenAskAgain(server.server.listeningPort, path, LIMIT_BYTES + 1)
        expect(first).toContain('413')
        expect(next).toContain('200')
      }
    })

    it(`answers the next request after the request hook denies ${path}`, async () => {
      await start({
        onRequest: ctx =>
          ctx.path === path ? { status: 403, code: 'FORBIDDEN', message: 'This upload is not allowed' } : undefined,
      })
      for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
        const [first, next] = await uploadThenAskAgain(server.server.listeningPort, path, 16)
        expect(first).toContain('403')
        expect(next).toContain('200')
      }
    })
  }
})
