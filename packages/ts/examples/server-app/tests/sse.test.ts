import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { openSseSession, type SseSession } from '../sse'

type SessionHandler = (session: SseSession) => void | Promise<void>

let server: Server | undefined

afterEach(
  () =>
    new Promise<void>(resolve => {
      const current = server
      server = undefined
      if (!current) {
        resolve()
        return
      }
      current.closeAllConnections()
      current.close(() => resolve())
    }),
)

function listen(handler: SessionHandler): Promise<string> {
  const instance = createServer((req, res) => {
    void handler(openSseSession(req, res))
  })
  server = instance
  return new Promise(resolve => {
    instance.listen(0, '127.0.0.1', () => {
      const address = instance.address() as AddressInfo
      resolve(`http://127.0.0.1:${address.port}/`)
    })
  })
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => {}
  const promise = new Promise<void>(res => {
    resolve = res
  })
  return { promise, resolve }
}

function parseFrames(body: string): unknown[] {
  return body
    .split('\n\n')
    .filter(part => part.startsWith('data: '))
    .map(part => JSON.parse(part.slice(6)))
}

describe('openSseSession', () => {
  it('delivers frames and ends the stream on close', async () => {
    const url = await listen(async session => {
      session.sendLatest({ step: 1 })
      await session.send({ step: 2 })
      session.close()
    })

    const response = await fetch(url)
    expect(response.headers.get('content-type')).toBe('text/event-stream')
    const frames = parseFrames(await response.text())
    expect(frames).toEqual([{ step: 1 }, { step: 2 }])
  })

  it('survives close, fail, and send called after the stream already ended', async () => {
    const url = await listen(async session => {
      session.sendLatest({ step: 1 })
      session.close()
      session.close()
      session.fail({ error: 'late' })
      session.sendLatest({ step: 2 })
      expect(await session.send({ step: 3 })).toBe(false)
    })

    const frames = parseFrames(await (await fetch(url)).text())
    expect(frames).toEqual([{ step: 1 }])
  })

  it('delivers a final error frame through fail', async () => {
    const url = await listen(session => {
      session.sendLatest({ step: 1 })
      session.fail({ error: 'broken' })
    })

    const frames = parseFrames(await (await fetch(url)).text())
    expect(frames).toEqual([{ step: 1 }, { error: 'broken' }])
  })

  it('aborts the signal when the client disconnects and ignores later writes', async () => {
    let capturedSession: SseSession | undefined
    const firstFrameSent = deferred()
    const aborted = deferred()

    const url = await listen(session => {
      capturedSession = session
      session.signal.addEventListener('abort', () => aborted.resolve(), { once: true })
      session.sendLatest({ step: 1 })
      firstFrameSent.resolve()
    })

    const controller = new AbortController()
    const response = await fetch(url, { signal: controller.signal })
    if (!response.body) throw new Error('expected a streaming body')
    const reader = response.body.getReader()
    await firstFrameSent.promise
    await reader.read()
    controller.abort()

    await aborted.promise
    if (!capturedSession) throw new Error('expected the handler to run')
    expect(capturedSession.signal.aborted).toBe(true)
    expect(capturedSession.isOpen()).toBe(false)

    capturedSession.sendLatest({ step: 2 })
    expect(await capturedSession.send({ step: 3 })).toBe(false)
    capturedSession.close()
    capturedSession.fail({ error: 'after disconnect' })
  })
})
