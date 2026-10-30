import { type ChildProcess, execFile, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { open } from 'node:fs/promises'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const run = promisify(execFile)

export const NODE_IMAGE = 'node:24-trixie-slim@sha256:54f84b4cf8432b21aaffd5d3ce8d41e12cea0d10d33c09d2f3c9879d49d6b446'
const REPOSITORY_ROOT = fileURLToPath(new URL('../../../../../../', import.meta.url))
const NODE_SCRIPT = fileURLToPath(new URL('./node-process.mjs', import.meta.url))
const CONTAINER_HTTP_PORT = 8080
const CONTAINER_TRANSPORT_PORT = 7000
const READY_TIMEOUT_MS = 90_000
const STOP_TIMEOUT_SECONDS = 10
const MEGABYTE_BYTES = 1024 * 1024
const KILOBYTE_BYTES = 1024
const MEMINFO_FIGURE_WIDTH = 16

export interface ContainerNode {
  base: string
  heapLimitBytes: number
  exited(): boolean
  output(): string
  oomKilled(): Promise<boolean>
  peakResidentBytes(): Promise<number>
  stop(): Promise<void>
}

export interface ContainerNodeOptions {
  nodeId: string
  etcdEndpoint: string
  keyPrefix: string
  heapMegabytes: number
  memoryMegabytes?: number
  meminfoPath?: string
}

async function docker(args: string[]): Promise<string> {
  const { stdout } = await run('docker', args, { env: { ...process.env, NODE_OPTIONS: '' } })
  return stdout.trim()
}

function reachableFromContainer(endpoint: string): string {
  const url = new URL(endpoint)
  if (url.hostname === '127.0.0.1' || url.hostname === 'localhost') url.hostname = 'host.docker.internal'
  return url.toString().replace(/\/$/, '')
}

function userFlags(): string[] {
  if (typeof process.getuid !== 'function' || typeof process.getgid !== 'function') return []
  return ['--user', `${process.getuid()}:${process.getgid()}`]
}

export async function startContainerNode(options: ContainerNodeOptions): Promise<ContainerNode> {
  const name = `narsil-memory-node-${randomUUID()}`
  const memoryFlags =
    options.memoryMegabytes === undefined
      ? []
      : [`--memory=${options.memoryMegabytes}m`, `--memory-swap=${options.memoryMegabytes}m`]
  const meminfoFlags = options.meminfoPath === undefined ? [] : ['--volume', `${options.meminfoPath}:/proc/meminfo`]
  const child: ChildProcess = spawn(
    'docker',
    [
      'run',
      '--name',
      name,
      ...memoryFlags,
      ...meminfoFlags,
      ...userFlags(),
      '--add-host=host.docker.internal:host-gateway',
      '--publish',
      `127.0.0.1::${CONTAINER_HTTP_PORT}`,
      '--volume',
      `${REPOSITORY_ROOT}:${REPOSITORY_ROOT}:ro`,
      '--env',
      `NARSIL_NODE_ID=${options.nodeId}`,
      '--env',
      'NARSIL_HTTP_HOST=0.0.0.0',
      '--env',
      `NARSIL_HTTP_PORT=${CONTAINER_HTTP_PORT}`,
      '--env',
      `NARSIL_TRANSPORT_PORT=${CONTAINER_TRANSPORT_PORT}`,
      '--env',
      `NARSIL_ETCD_ENDPOINT=${reachableFromContainer(options.etcdEndpoint)}`,
      '--env',
      `NARSIL_ETCD_KEY_PREFIX=${options.keyPrefix}`,
      NODE_IMAGE,
      'node',
      `--max-old-space-size=${options.heapMegabytes}`,
      NODE_SCRIPT,
    ],
    { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, NODE_OPTIONS: '' } },
  )

  let output = ''
  let hasExited = false
  child.stdout?.on('data', (chunk: Buffer) => {
    output += chunk.toString()
  })
  child.stderr?.on('data', (chunk: Buffer) => {
    output += chunk.toString()
  })
  const exitedPromise = new Promise<void>(resolve => {
    child.once('exit', (code, signal) => {
      hasExited = true
      output += `\nexited with code ${code} and signal ${signal}\n`
      resolve()
    })
  })

  async function remove(): Promise<void> {
    await docker(['rm', '--force', name]).catch(() => '')
  }

  const deadline = Date.now() + READY_TIMEOUT_MS
  while (!output.includes(`READY ${options.nodeId}`)) {
    if (hasExited || Date.now() > deadline) {
      await remove()
      throw new Error(`${options.nodeId} did not start in its container: ${output.slice(-3_000)}`)
    }
    await sleep(100)
  }
  const published = await docker(['port', name, String(CONTAINER_HTTP_PORT)])
  const port = published.split('\n')[0]?.split(':').pop() ?? ''

  return {
    base: `http://127.0.0.1:${port}`,
    heapLimitBytes: options.heapMegabytes * MEGABYTE_BYTES,
    exited: () => hasExited,
    output: () => output,
    async oomKilled() {
      return (await docker(['inspect', '--format', '{{.State.OOMKilled}}', name]).catch(() => 'false')) === 'true'
    },
    async peakResidentBytes() {
      const status = await docker(['exec', name, 'cat', '/proc/1/status'])
      const peak = /^VmHWM:\s+(\d+) kB$/m.exec(status)
      if (peak === null) throw new Error(`the container reported no peak resident memory: ${status}`)
      return Number(peak[1]) * KILOBYTE_BYTES
    },
    async stop() {
      if (!hasExited) await docker(['stop', '--time', String(STOP_TIMEOUT_SECONDS), name]).catch(() => '')
      await exitedPromise
      await remove()
    },
  }
}

function meminfoLine(label: string, bytes: number): string {
  return `${`${label}:`.padEnd(MEMINFO_FIGURE_WIDTH)}${String(Math.max(0, Math.floor(bytes / KILOBYTE_BYTES))).padStart(MEMINFO_FIGURE_WIDTH)} kB\n`
}

export async function writeMeminfo(path: string, totalBytes: number, availableBytes: number): Promise<void> {
  const file = await open(path, 'a+')
  await file.close()
  const handle = await open(path, 'r+')
  try {
    await handle.write(meminfoLine('MemTotal', totalBytes) + meminfoLine('MemAvailable', availableBytes), 0)
  } finally {
    await handle.close()
  }
}
