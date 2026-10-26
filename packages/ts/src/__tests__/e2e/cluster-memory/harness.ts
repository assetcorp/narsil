import { type ChildProcess, spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

const NODE_SCRIPT = fileURLToPath(new URL('./node-process.mjs', import.meta.url))
const READY_TIMEOUT_MS = 60_000
const STOP_TIMEOUT_MS = 15_000

export interface NodeProcess {
  nodeId: string
  base: string
  heapLimitBytes: number
  exited(): boolean
  output(): string
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
  inFlightWriteFraction?: number
}): Promise<NodeProcess> {
  const httpPort = await freePort()
  const transportPort = await freePort()
  const { NARSIL_IN_FLIGHT_WRITE_FRACTION: _inherited, ...parentEnv } = process.env
  const child: ChildProcess = spawn(process.execPath, [`--max-old-space-size=${options.heapMegabytes}`, NODE_SCRIPT], {
    env: {
      ...parentEnv,
      ...(options.inFlightWriteFraction === undefined
        ? {}
        : { NARSIL_IN_FLIGHT_WRITE_FRACTION: String(options.inFlightWriteFraction) }),
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

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${options.nodeId} did not start within ${READY_TIMEOUT_MS} ms: ${output}`))
    }, READY_TIMEOUT_MS)
    child.stdout?.on('data', (chunk: Buffer) => {
      output += chunk.toString()
      if (output.includes(`READY ${options.nodeId}`)) {
        clearTimeout(timer)
        resolve()
      }
    })
    child.once('exit', code => {
      clearTimeout(timer)
      reject(new Error(`${options.nodeId} exited with code ${code} before it started: ${output}`))
    })
  })

  return {
    nodeId: options.nodeId,
    base: `http://127.0.0.1:${httpPort}`,
    heapLimitBytes: options.heapMegabytes * 1024 * 1024,
    exited: () => hasExited,
    output: () => output,
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
