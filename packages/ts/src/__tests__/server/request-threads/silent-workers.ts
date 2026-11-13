import { randomUUID } from 'node:crypto'
import { request } from 'node:http'
import { BroadcastChannel } from 'node:worker_threads'
import { type NarsilPlugin, registerLanguage } from '../../../index'
import type { ServerOptions } from '../../../server'
import type { WorkerConfig } from '../../../types/config'
import { scaledOut, startTestServer, type TestServer, waitFor } from '../helpers'

export const ARMED_TOKEN = 'suspend'
export const INDEX = 'tickets'
export const TICKETS = 1_200
export const SETUP_MS = 60_000

const ARMED_STEM = 'hold'
const BARRIER_WORDS = 3
const BARRIER_REACHED = 0
const BARRIER_ARMED = 1
const BARRIER_RELEASED = 2
const SEARCH_TIMEOUT_MS = 10_000
const distPackage = new URL('../../../../dist/index.mjs', import.meta.url)
export const distEntry = new URL('../../../../dist/workers/entry.mjs', import.meta.url)

export type ArmedTokenEffect = { kind: 'block'; waitMs: number | null } | { kind: 'throw' }

export interface Answer<T> {
  status: number
  connection: string | undefined
  body: T
}

export interface Search {
  count: number
  hits: Array<{ id: string; document: { title: string } }>
}

export interface ServerWithCopies extends TestServer {
  crashes: Array<{ at: number; error: Error }>
  armWorker(): Promise<void>
  armedTokenReached(): Promise<void>
  armedTokenHeld(): boolean
  releaseWorker(): void
  searchOnAThread(term: string): Promise<Answer<Search> | null>
  shutDown(): Promise<void>
}

function stemmer(token: string): string {
  return token === ARMED_TOKEN ? ARMED_STEM : token
}

function armedTokenEffectSource(effect: ArmedTokenEffect): string {
  if (effect.kind === 'throw') return `throw new Error('the test failed this copy write on purpose')`
  const waitArgument = effect.waitMs === null ? '' : `, ${effect.waitMs}`
  return `if (Atomics.wait(barrier, ${BARRIER_RELEASED}, 0${waitArgument}) === 'timed-out') throw new Error('the test never released the blocked stemmer')`
}

function languageBootstrap(language: string, channel: string, effect: ArmedTokenEffect, failOnToken?: string): string {
  const source = `import { BroadcastChannel, workerData } from 'node:worker_threads'
import { registerLanguage } from ${JSON.stringify(distPackage.href)}
let barrier
const channel = new BroadcastChannel(${JSON.stringify(channel)})
channel.onmessage = message => {
  if (workerData?.workerId !== 0) return
  barrier = new Int32Array(message.data)
  Atomics.add(barrier, ${BARRIER_REACHED}, 1)
}
channel.unref()
registerLanguage({
  name: ${JSON.stringify(language)}, revision: '1', stopWords: new Set(),
  stemmer(token) {
    if (workerData?.workerId === 0 && token === ${JSON.stringify(failOnToken)}) throw new Error('the test failed this copy write on purpose')
    if (token === ${JSON.stringify(ARMED_TOKEN)} && barrier !== undefined && Atomics.compareExchange(barrier, ${BARRIER_ARMED}, 1, 2) === 1) {
      ${armedTokenEffectSource(effect)}
    }
    return token === ${JSON.stringify(ARMED_TOKEN)} ? ${JSON.stringify(ARMED_STEM)} : token
  },
})`
  return `data:text/javascript,${encodeURIComponent(source)}`
}

export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, Math.max(0, ms)))
}

export function onNewConnection<T>(
  base: string,
  path: string,
  options: { body?: unknown; headers?: Record<string, string>; timeoutMs: number },
): Promise<Answer<T>> {
  const url = new URL(path, base)
  const payload = options.body === undefined ? undefined : JSON.stringify(options.body)
  const headers: Record<string, string> = { ...options.headers }
  if (payload !== undefined) headers['content-type'] = 'application/json'
  return new Promise((resolve, reject) => {
    const outgoing = request(
      url,
      { agent: false, method: payload === undefined ? 'GET' : 'POST', headers, timeout: options.timeoutMs },
      incoming => {
        let text = ''
        incoming.setEncoding('utf8')
        incoming.on('data', chunk => {
          text += chunk
        })
        incoming.on('end', () =>
          resolve({
            status: incoming.statusCode ?? 0,
            connection: incoming.headers.connection,
            body: (text.length > 0 ? JSON.parse(text) : undefined) as T,
          }),
        )
        incoming.on('error', reject)
      },
    )
    outgoing.on('timeout', () => outgoing.destroy(new Error(`${path} never answered`)))
    outgoing.on('error', reject)
    outgoing.end(payload)
  })
}

export async function startServerWithCopies(
  language: string,
  effect: ArmedTokenEffect,
  setup: {
    server?: Omit<ServerOptions, 'host' | 'port'>
    plugins?: NarsilPlugin[]
    workers?: Pick<WorkerConfig, 'silenceBeforeProbeMs' | 'silenceBeforeRetirementMs' | 'maxThreadsLeftRunning'>
    failOnToken?: string
  } = {},
): Promise<ServerWithCopies> {
  registerLanguage({ name: language, revision: '1', stopWords: new Set(), stemmer })
  const channel = new BroadcastChannel(randomUUID())
  const barrier = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * BARRIER_WORDS))
  const crashes: Array<{ at: number; error: Error }> = []
  let mainQueries = 0
  const release = () => {
    Atomics.store(barrier, BARRIER_RELEASED, 1)
    Atomics.notify(barrier, BARRIER_RELEASED)
  }
  const server = await startTestServer(
    setup.server,
    {
      plugins: setup.plugins,
      workers: {
        ...setup.workers,
        count: 1,
        bootstrapModule: languageBootstrap(language, channel.name, effect, setup.failOnToken),
      },
    },
    async engine => {
      engine.on('workerCrash', ({ error }) => crashes.push({ at: Date.now(), error }))
      const query = engine.query.bind(engine)
      engine.query = (indexName, params) => {
        mainQueries++
        return query(indexName, params)
      }
    },
  )
  async function shutDown(): Promise<void> {
    release()
    channel.close()
    await server.stop()
  }
  try {
    await server.engine.createIndex(INDEX, { schema: { title: 'string' }, language })
    await server.engine.insertBatch(
      INDEX,
      Array.from({ length: TICKETS }, (_, i) => ({ id: `ticket-${i}`, title: `ticket ${i}` })),
      { wait: true },
    )
    await waitFor(() => scaledOut(server.engine, INDEX), SETUP_MS)
    await waitFor(async () => server.server.requestThreadCount === 1, SETUP_MS)
  } catch (error) {
    await shutDown()
    throw error
  }
  return {
    ...server,
    crashes,
    async armWorker() {
      channel.postMessage(barrier.buffer)
      await waitFor(async () => Atomics.load(barrier, BARRIER_REACHED) > 0)
      Atomics.store(barrier, BARRIER_ARMED, 1)
    },
    armedTokenReached: () => waitFor(async () => Atomics.load(barrier, BARRIER_ARMED) === 2),
    armedTokenHeld: () => Atomics.load(barrier, BARRIER_ARMED) === 2,
    releaseWorker: release,
    async searchOnAThread(term) {
      const before = mainQueries
      const answer = await onNewConnection<Search>(server.base, `/indexes/${INDEX}/search`, {
        body: { term, limit: 1 },
        timeoutMs: SEARCH_TIMEOUT_MS,
      })
      return answer.status === 200 && mainQueries === before ? answer : null
    },
    shutDown,
  }
}
