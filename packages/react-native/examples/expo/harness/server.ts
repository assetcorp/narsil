import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { basename, join } from 'node:path'

const LARGEST_BODY_BYTES = 536_870_912
const FILE_NAME = /^[A-Za-z0-9._-]+$/

export interface PhoneReport {
  kind: string
  platform: string
  version: string
  payload: { passed: boolean; result?: unknown; error?: unknown }
}

export interface PhoneEvent {
  event: string
  details: Record<string, unknown>
  at: number
}

interface Waiter<T> {
  accepts(value: T): boolean
  resolve(value: T): void
  reject(error: Error): void
}

interface TaskFailure {
  at: number
  error: Error
}

export interface Harness {
  queue(task: Record<string, unknown>): void
  unqueue(kind: string): void
  nextPickup(kind: string, timeoutMs: number): Promise<void>
  note(event: string, details: Record<string, unknown>): void
  acknowledged(): ReadonlySet<string>
  forgetAcks(): void
  events(): readonly PhoneEvent[]
  nextReport(kind: string, timeoutMs: number): Promise<PhoneReport>
  nextEvent(event: string, timeoutMs: number, since?: number): Promise<PhoneEvent>
  acksReach(count: number, timeoutMs: number): Promise<void>
  close(): Promise<void>
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let total = 0
    request.on('data', (chunk: Buffer) => {
      total += chunk.byteLength
      if (total > LARGEST_BODY_BYTES) {
        reject(new Error('The request body passes the harness limit'))
        request.destroy()
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    request.on('error', reject)
  })
}

function answer(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json' })
  response.end(JSON.stringify(body))
}

function safeName(name: unknown): string {
  if (typeof name !== 'string' || !FILE_NAME.test(name)) throw new Error(`The file name ${String(name)} is not allowed`)
  return basename(name)
}

function waitFor<T>(waiters: Array<Waiter<T>>, accepts: (value: T) => boolean, timeoutMs: number, what: string) {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      const index = waiters.indexOf(waiter)
      if (index >= 0) waiters.splice(index, 1)
      reject(new Error(`Timed out after ${timeoutMs} ms waiting for ${what}`))
    }, timeoutMs)
    timer.unref()
    const waiter: Waiter<T> = {
      accepts,
      resolve(value) {
        clearTimeout(timer)
        resolve(value)
      },
      reject(error) {
        clearTimeout(timer)
        reject(error)
      },
    }
    waiters.push(waiter)
  })
}

function abandon<T>(waiters: Array<Waiter<T>>, error: Error): void {
  for (const waiter of waiters.splice(0)) waiter.reject(error)
}

function settle<T>(waiters: Array<Waiter<T>>, value: T): void {
  for (const waiter of [...waiters]) {
    if (!waiter.accepts(value)) continue
    waiters.splice(waiters.indexOf(waiter), 1)
    waiter.resolve(value)
  }
}

export async function startHarness(port: number, outputDirectory: string, fixtures: string): Promise<Harness> {
  mkdirSync(outputDirectory, { recursive: true })
  const ackLog = join(outputDirectory, 'acks.log')
  const eventLog = join(outputDirectory, 'events.log')
  const tasks: Array<Record<string, unknown>> = []
  const acks = new Set<string>()
  const events: PhoneEvent[] = []
  const reportWaiters: Array<Waiter<PhoneReport>> = []
  const eventWaiters: Array<Waiter<PhoneEvent>> = []
  const ackWaiters: Array<Waiter<number>> = []
  const pickupWaiters: Array<Waiter<string>> = []
  const failures: TaskFailure[] = []

  function note(event: string, details: Record<string, unknown>): void {
    const noted = { event, details, at: Date.now() }
    appendFileSync(eventLog, `${JSON.stringify(noted)}\n`)
    events.push(noted)
  }

  async function route(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? '/', 'http://harness')
    if (request.method === 'GET' && url.pathname === '/task') {
      const task = tasks.shift()
      answer(response, 200, task ?? { kind: 'idle' })
      if (task !== undefined) settle(pickupWaiters, String(task.kind))
      return
    }
    if (request.method === 'GET' && url.pathname === '/download') {
      const bytes = readFileSync(join(fixtures, safeName(url.searchParams.get('name'))))
      answer(response, 200, { base64: bytes.toString('base64') })
      return
    }
    if (request.method !== 'POST') {
      answer(response, 404, { error: 'unknown route' })
      return
    }
    const body = JSON.parse(await readBody(request)) as Record<string, unknown>
    if (url.pathname === '/ack' && Array.isArray(body.ids)) {
      const ids = body.ids.filter((id): id is string => typeof id === 'string')
      appendFileSync(ackLog, ids.map(id => `${id}\n`).join(''))
      for (const id of ids) acks.add(id)
      settle(ackWaiters, acks.size)
    } else if (url.pathname === '/event') {
      const event = {
        event: String(body.event),
        details: (body.details ?? {}) as Record<string, unknown>,
        at: Date.now(),
      }
      appendFileSync(eventLog, `${JSON.stringify(event)}\n`)
      events.push(event)
      settle(eventWaiters, event)
    } else if (url.pathname === '/report') {
      const report = body as unknown as PhoneReport
      writeFileSync(
        join(outputDirectory, `${safeName(report.kind)}-${Date.now()}.json`),
        JSON.stringify(report, null, 2),
      )
      settle(reportWaiters, report)
      if (!report.payload.passed) {
        const error = new Error(`The ${report.kind} task failed: ${JSON.stringify(report.payload.error)}`)
        failures.push({ at: Date.now(), error })
        abandon(eventWaiters, error)
        abandon(ackWaiters, error)
      }
    } else if (url.pathname === '/upload') {
      writeFileSync(join(outputDirectory, safeName(body.name)), Buffer.from(String(body.base64), 'base64'))
    } else {
      answer(response, 404, { error: 'unknown route' })
      return
    }
    answer(response, 200, { ok: true })
  }

  const server = createServer((request, response) => {
    route(request, response).catch(error => answer(response, 400, { error: String(error) }))
  })
  await new Promise<void>(resolve => server.listen(port, '0.0.0.0', resolve))

  return {
    queue: task => tasks.push(task),
    unqueue(kind) {
      for (let index = tasks.length - 1; index >= 0; index--) {
        if (tasks[index]?.kind === kind) tasks.splice(index, 1)
      }
    },
    nextPickup: async (kind, timeoutMs) => {
      await waitFor(pickupWaiters, taken => taken === kind, timeoutMs, `the app to pick up the ${kind} task`)
    },
    note,
    acknowledged: () => acks,
    forgetAcks: () => acks.clear(),
    events: () => events,
    nextReport: (kind, timeoutMs) =>
      waitFor(reportWaiters, report => report.kind === kind, timeoutMs, `the ${kind} report`),
    nextEvent(event, timeoutMs, since = Number.POSITIVE_INFINITY) {
      const earlier = events.find(value => value.event === event && value.at >= since)
      if (earlier !== undefined) return Promise.resolve(earlier)
      const failed = failures.find(failure => failure.at >= since)
      if (failed !== undefined) return Promise.reject(failed.error)
      return waitFor(eventWaiters, value => value.event === event, timeoutMs, event)
    },
    async acksReach(count, timeoutMs) {
      if (acks.size >= count) return
      await waitFor(ackWaiters, size => size >= count, timeoutMs, `${count} acknowledged writes`)
    },
    close: () => new Promise<void>(resolve => server.close(() => resolve())),
  }
}
