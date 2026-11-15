import { Agent, type ClientRequest, request } from 'node:http'
import type { Socket } from 'node:net'
import { expect, it } from 'vitest'
import { ErrorCodes } from '../../errors'
import { waitFor } from './helpers'
import { ARMED_TOKEN, INDEX, sleep, startServerWithCopies, TICKETS } from './request-threads/silent-workers'

it.concurrent('waits for an abandoned thread to close its client connection before close resolves', async () => {
  const srv = await startServerWithCopies(
    'close-abandoned-thread',
    { kind: 'block', waitMs: null },
    {
      workers: { silenceBeforeProbeMs: 1_000, silenceBeforeRetirementMs: 4_000 },
    },
  )
  const pending = request(`${srv.base}/indexes/${INDEX}/search`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
  })
  pending.on('error', () => undefined)
  pending.on('response', response => response.resume())
  const connected = new Promise<Socket>(resolve => pending.once('socket', resolve))
  let closed = false
  let closing: Promise<void> | undefined
  try {
    await srv.armWorker()
    pending.end(JSON.stringify({ term: ARMED_TOKEN, limit: 1 }))
    const socket = await connected
    await srv.armedTokenReached()
    await waitFor(async () => srv.crashes.length > 0)
    await waitFor(
      async () => srv.server.requestThreadCount === 1 && (await srv.search('ticket')).body.count === TICKETS,
    )
    closing = srv.server.close().then(() => {
      closed = true
    })
    await sleep(200)
    expect({ closeResolved: closed, clientConnectionOpen: !socket.destroyed }).toEqual({
      closeResolved: false,
      clientConnectionOpen: true,
    })
    srv.releaseWorker()
    await closing
    await waitFor(async () => socket.destroyed, 2_000)
    expect(socket.destroyed).toBe(true)
  } finally {
    srv.releaseWorker()
    pending.destroy()
    await closing
    await srv.shutDown()
  }
}, 45_000)

it.concurrent('rejects at the close deadline and closes an abandoned connection without answering after recovery', async () => {
  let admitMain: () => void = () => undefined
  let admitResponsive: () => void = () => undefined
  let releaseRequests: () => void = () => undefined
  const mainAdmitted = new Promise<void>(resolve => {
    admitMain = resolve
  })
  const responsiveAdmitted = new Promise<void>(resolve => {
    admitResponsive = resolve
  })
  const requestsReleased = new Promise<void>(resolve => {
    releaseRequests = resolve
  })
  const srv = await startServerWithCopies(
    'close-blocked-deadline',
    { kind: 'block', waitMs: null },
    {
      workers: { silenceBeforeProbeMs: 1_000, silenceBeforeRetirementMs: 4_000 },
      server: {
        async onRequest(ctx) {
          const held = ctx.headers['x-close-test']
          if (held === undefined) return undefined
          if (held === 'main') admitMain()
          else admitResponsive()
          await requestsReleased
          return undefined
        },
      },
    },
  )
  const agent = new Agent({ keepAlive: true })
  const held: ClientRequest[] = []
  async function holdConnection(name: string): Promise<Socket> {
    const outgoing = request(`${srv.base}/indexes/${INDEX}/count`, { agent, headers: { 'x-close-test': name } })
    held.push(outgoing)
    outgoing.on('error', () => undefined)
    outgoing.on('response', response => response.resume())
    const connected = new Promise<Socket>(resolve => outgoing.once('socket', resolve))
    outgoing.end()
    return connected
  }
  const pending = request(`${srv.base}/indexes/${INDEX}/search`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
  })
  const connected = new Promise<Socket>(resolve => pending.once('socket', resolve))
  let answers = 0
  let bytesReceived = 0
  pending.on('error', () => undefined)
  pending.on('response', response => {
    answers++
    response.resume()
  })
  try {
    await srv.armWorker()
    pending.end(JSON.stringify({ term: ARMED_TOKEN, limit: 1 }))
    const blockedSocket = await connected
    blockedSocket.on('data', chunk => {
      bytesReceived += chunk.length
    })
    await srv.armedTokenReached()
    await waitFor(async () => srv.crashes.length > 0)
    expect(srv.server.requestThreadCount).toBe(0)
    const mainSocket = await new Promise<Socket>((resolve, reject) => {
      const outgoing = request(`${srv.base}/livez`, { agent }, response => {
        const socket = response.socket
        response.resume()
        response.on('end', () => {
          expect(response.statusCode).toBe(200)
          resolve(socket)
        })
      })
      outgoing.on('error', reject)
      outgoing.end()
    })
    expect(srv.server.requestThreadCount).toBe(0)
    expect(await holdConnection('main')).toBe(mainSocket)
    await mainAdmitted
    await waitFor(
      async () => srv.server.requestThreadCount === 1 && (await srv.search('ticket')).body.count === TICKETS,
    )
    const responsiveSocket = await holdConnection('responsive')
    await responsiveAdmitted
    expect(mainSocket.destroyed).toBe(false)
    const started = performance.now()
    const closing = srv.server.close().then(
      () => undefined,
      error => error,
    )
    await sleep(29_000)
    expect(mainSocket.destroyed).toBe(false)
    expect(responsiveSocket.destroyed).toBe(false)
    const failure: unknown = await closing
    const elapsed = performance.now() - started
    expect(failure).toMatchObject({
      code: ErrorCodes.WORKER_TIMEOUT,
      details: { threads: 1, deadlineMs: 30_000 },
      message: expect.stringMatching(/connections: 1;.*30000ms/),
    })
    expect(elapsed).toBeGreaterThanOrEqual(30_000)
    expect(elapsed).toBeLessThan(31_000)
    expect(srv.server.listeningPort).toBe(-1)
    await waitFor(async () => mainSocket.destroyed, 2_000)
    await waitFor(async () => responsiveSocket.destroyed, 2_000)
    expect(blockedSocket.destroyed).toBe(false)
    srv.releaseWorker()
    await waitFor(async () => blockedSocket.destroyed, 2_000)
    expect({ answers, bytesReceived }).toEqual({ answers: 0, bytesReceived: 0 })
    const retried = performance.now()
    await expect(srv.server.close()).rejects.toMatchObject({ code: ErrorCodes.WORKER_TIMEOUT })
    expect(performance.now() - retried).toBeLessThan(1_000)
  } finally {
    srv.releaseWorker()
    releaseRequests()
    pending.destroy()
    for (const outgoing of held) outgoing.destroy()
    agent.destroy()
    await srv.shutDown().catch(() => undefined)
    await srv.engine.shutdown()
  }
}, 45_000)
