import { type ChildProcess, spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { expect } from 'vitest'
import type { ClusterMemoryConfig } from '../../../distribution/cluster-node/types'
import type { ServerLimits } from '../../../server/types'

const NODE_SCRIPT = fileURLToPath(new URL('./node-process.mjs', import.meta.url))
const SERVER_REFUSAL_REASONS = ['parse_would_fill_memory', 'request_bytes_in_flight']
const READ_BACK_DOCUMENTS = 1_000
const READ_BACK_ATTEMPTS = 20
const READ_BACK_RETRY_MS = 500
const READY_TIMEOUT_MS = 60_000
const STOP_TIMEOUT_MS = 15_000
const PEAK_REPORT_TIMEOUT_MS = 5_000
const PEAK_REPORT_POLL_MS = 20
const PEAK_OLD_GENERATION_LINE = /PEAK_OLD_GENERATION (\d+)\n/
const PORT_ATTEMPTS = 5
const PORT_TAKEN_LINES = [/Failed to listen on /, /EADDRINUSE/]

export interface NodeProcess {
  nodeId: string
  base: string
  heapLimitBytes: number
  exited(): boolean
  output(): string
  peakOldGenerationBytes(): Promise<number>
  stop(): Promise<void>
}

export interface HttpReply {
  status: number
  body: Record<string, unknown>
}

export async function freePort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (address === null || typeof address === 'string') {
        server.close(() => reject(new Error('The system offered no TCP port')))
        return
      }
      server.close(() => resolve(address.port))
    })
  })
}

export async function startNodeProcess(options: {
  nodeId: string
  etcdEndpoint: string
  keyPrefix: string
  heapMegabytes: number
  memory?: ClusterMemoryConfig
  serverLimits?: ServerLimits
}): Promise<NodeProcess> {
  for (let attempt = 1; ; attempt++) {
    const started = await spawnNodeProcess(options, await freePort(), await freePort())
    if (started !== null) return started
    if (attempt === PORT_ATTEMPTS) throw new Error(`${options.nodeId} found no free port in ${PORT_ATTEMPTS} attempts`)
  }
}

export function lostPortRace(output: string): boolean {
  return PORT_TAKEN_LINES.some(line => line.test(output))
}

async function spawnNodeProcess(
  options: Parameters<typeof startNodeProcess>[0],
  httpPort: number,
  transportPort: number,
): Promise<NodeProcess | null> {
  const { NARSIL_MEMORY_CONFIG: _inherited, NARSIL_SERVER_LIMITS: _inheritedLimits, ...parentEnv } = process.env
  const child: ChildProcess = spawn(process.execPath, [`--max-old-space-size=${options.heapMegabytes}`, NODE_SCRIPT], {
    env: {
      ...parentEnv,
      ...(options.memory === undefined ? {} : { NARSIL_MEMORY_CONFIG: JSON.stringify(options.memory) }),
      ...(options.serverLimits === undefined ? {} : { NARSIL_SERVER_LIMITS: JSON.stringify(options.serverLimits) }),
      NODE_OPTIONS: '',
      NARSIL_NODE_ID: options.nodeId,
      NARSIL_HTTP_PORT: String(httpPort),
      NARSIL_TRANSPORT_PORT: String(transportPort),
      NARSIL_ETCD_ENDPOINT: options.etcdEndpoint,
      NARSIL_ETCD_KEY_PREFIX: options.keyPrefix,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  let output = ''
  let hasExited = false
  const exitedPromise = new Promise<void>(resolve => {
    child.once('exit', (code, signal) => {
      hasExited = true
      output += `\nexited with code ${code} and signal ${signal}\n`
      resolve()
    })
  })
  child.stderr?.on('data', (chunk: Buffer) => {
    output += chunk.toString()
  })

  const ready = await new Promise<boolean>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${options.nodeId} did not start within ${READY_TIMEOUT_MS} ms: ${output}`))
    }, READY_TIMEOUT_MS)
    child.stdout?.on('data', (chunk: Buffer) => {
      output += chunk.toString()
      if (output.includes(`READY ${options.nodeId}`)) {
        clearTimeout(timer)
        resolve(true)
      }
    })
    child.once('exit', code => {
      clearTimeout(timer)
      if (lostPortRace(output)) resolve(false)
      else reject(new Error(`${options.nodeId} exited with code ${code} before it started: ${output}`))
    })
  })
  if (!ready) return null

  return {
    nodeId: options.nodeId,
    base: `http://127.0.0.1:${httpPort}`,
    heapLimitBytes: options.heapMegabytes * 1024 * 1024,
    exited: () => hasExited,
    output: () => output,
    async peakOldGenerationBytes() {
      const reported = output.length
      child.kill('SIGUSR2')
      const deadline = Date.now() + PEAK_REPORT_TIMEOUT_MS
      while (Date.now() < deadline && !hasExited) {
        const match = PEAK_OLD_GENERATION_LINE.exec(output.slice(reported))
        if (match !== null) return Number(match[1])
        await sleep(PEAK_REPORT_POLL_MS)
      }
      throw new Error(`${options.nodeId} reported no old-generation peak: ${output.slice(-2_000)}`)
    },
    async stop() {
      if (hasExited) return
      child.kill('SIGTERM')
      const stopped = await Promise.race([exitedPromise.then(() => true), sleep(STOP_TIMEOUT_MS).then(() => false)])
      if (!stopped) {
        child.kill('SIGKILL')
        await exitedPromise
      }
    },
  }
}

export async function request(base: string, method: string, path: string, body?: unknown): Promise<HttpReply> {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await response.text()
  const parsed: unknown = text.length > 0 ? JSON.parse(text) : {}
  const record = parsed !== null && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {}
  return { status: response.status, body: record }
}

export function errorOf(reply: HttpReply): { code: unknown; details: Record<string, unknown> } {
  const error = reply.body.error
  if (error === null || typeof error !== 'object') return { code: null, details: {} }
  const { code, details } = error as { code?: unknown; details?: unknown }
  return {
    code: code ?? null,
    details: details !== null && typeof details === 'object' ? (details as Record<string, unknown>) : {},
  }
}

export function isServerMemoryRefusal(reply: HttpReply): boolean {
  const refusal = errorOf(reply)
  return (
    reply.status === 429 &&
    refusal.code === 'TOO_MANY_REQUESTS' &&
    SERVER_REFUSAL_REASONS.includes(String(refusal.details.reason))
  )
}

export async function expectEveryDocumentReadsBack(
  base: string,
  indexName: string,
  kept: ReadonlyMap<string, object>,
  sliceDocuments = READ_BACK_DOCUMENTS,
): Promise<void> {
  const docIds = [...kept.keys()]
  for (let start = 0; start < docIds.length; start += sliceDocuments) {
    const slice = docIds.slice(start, start + sliceDocuments)
    let reply = await request(base, 'POST', `/indexes/${indexName}/documents/_multi-get`, { docIds: slice })
    for (let attempt = 1; attempt < READ_BACK_ATTEMPTS && isServerMemoryRefusal(reply); attempt++) {
      await sleep(READ_BACK_RETRY_MS)
      reply = await request(base, 'POST', `/indexes/${indexName}/documents/_multi-get`, { docIds: slice })
    }
    expect(reply.status, JSON.stringify(reply.body).slice(0, 500)).toBe(200)
    const documents = (reply.body.documents ?? {}) as Record<string, unknown>
    for (const docId of slice)
      expect(documents[docId], `${docId} was acknowledged`).toMatchObject(kept.get(docId) ?? {})
  }
}

export async function waitFor(
  description: string,
  timeoutMs: number,
  check: () => Promise<boolean>,
  intervalMs = 250,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await check()) return
    await sleep(intervalMs)
  }
  throw new Error(`Timed out after ${timeoutMs} ms waiting for ${description}`)
}
