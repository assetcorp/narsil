import { type ChildProcess, spawn } from 'node:child_process'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import type { TlsBundles } from '../../distribution/transport/tcp-tls/fixtures'
import { freePort, lostPortRace } from '../cluster-memory/harness'
import { ETCD_ROOT_PASSWORD, type EtcdMembers } from './etcd-members'
import { type LinkProxy, startLinkProxy } from './link-proxy'

const NODE_SCRIPT = fileURLToPath(new URL('./fault-node.mjs', import.meta.url))
const READY_TIMEOUT_MS = 90_000
const STOP_TIMEOUT_MS = 15_000
const READY_LINE = /READY (\S+)\n/
const PORT_ATTEMPTS = 5
const NODE_ID_FILE = '.narsil-node-id'

export interface FleetSettings {
  keyPrefix: string
  partitionCount: number
  replicationFactor: number
  heartbeatTtlSeconds: number
  controllerLeaseTtlMs: number
  standbyRetryMs: number
  waitForServingMs: number
  fixedNodeIds: boolean
  backups?: { directory: string; keyPrefix: string }
  transport?: 'tcp' | 'grpc'
  rustSlots?: readonly number[]
  nodeLeftDelayMs?: number
  slotSettings?: Readonly<Record<number, Readonly<Record<string, unknown>>>>
}

export const RUST_NODE_VARIABLE = 'NARSIL_RUST_CLUSTER_NODE'

function rustNodeBinary(): string {
  const binary = process.env[RUST_NODE_VARIABLE]
  if (binary === undefined || binary === '') {
    throw new Error(`${RUST_NODE_VARIABLE} must name the Rust fault node binary to start a Rust slot`)
  }
  return binary
}

export interface FleetNode {
  readonly slot: number
  readonly base: string
  readonly transportAddress: string
  nodeId(): string
  running(): boolean
  output(): string
}

interface Slot {
  slot: number
  httpPort: number
  transportPort: number
  transportProxy: LinkProxy
  etcdProxies: LinkProxy[]
  directory: string
  child: ChildProcess | null
  exited: Promise<void>
  nodeId: string
  output: string
}

export interface Fleet {
  readonly nodes: readonly FleetNode[]
  start(slot: number): Promise<void>
  kill(slot: number): Promise<void>
  stop(slot: number): Promise<void>
  pause(slot: number): void
  resume(slot: number): void
  wipe(slot: number): Promise<void>
  isolate(slot: number): void
  blackhole(slot: number): void
  reconnect(slot: number): void
  cutCoordinator(slot: number): void
  healCoordinator(slot: number): void
  stopAll(): Promise<void>
  remove(): Promise<void>
}

export async function startFleet(
  size: number,
  etcd: EtcdMembers,
  bundles: TlsBundles | null,
  settings: FleetSettings,
): Promise<Fleet> {
  const slots: Slot[] = []
  for (let slot = 0; slot < size; slot++) {
    const etcdProxies: LinkProxy[] = []
    for (const hostPort of etcd.hostPorts) etcdProxies.push(await startLinkProxy(() => hostPort))
    slots.push({
      slot,
      httpPort: await freePort(),
      transportPort: await freePort(),
      transportProxy: await startLinkProxy(() => slotAt(slot).transportPort),
      etcdProxies,
      directory: await mkdtemp(join(tmpdir(), `narsil-fault-node-${slot}-`)),
      child: null,
      exited: Promise.resolve(),
      nodeId: '',
      output: '',
    })
  }

  function slotAt(slot: number): Slot {
    const found = slots[slot]
    if (found === undefined) throw new Error(`The fleet holds no slot ${slot}`)
    return found
  }

  function nodeSettings(entry: Slot): Record<string, unknown> {
    const scheme = etcd.secure ? 'https' : 'http'
    return {
      etcdEndpoints: entry.etcdProxies.map(proxy => `${scheme}://127.0.0.1:${proxy.port}`),
      keyPrefix: settings.keyPrefix,
      heartbeatTtlSeconds: settings.heartbeatTtlSeconds,
      controllerLeaseTtlMs: settings.controllerLeaseTtlMs,
      standbyRetryMs: settings.standbyRetryMs,
      partitionCount: settings.partitionCount,
      replicationFactor: settings.replicationFactor,
      waitForServingMs: settings.waitForServingMs,
      httpPort: entry.httpPort,
      transportPort: entry.transportPort,
      advertisedPort: entry.transportProxy.port,
      directory: entry.directory,
      ...(settings.fixedNodeIds ? { nodeId: `fault-node-${entry.slot}` } : {}),
      ...(settings.transport === undefined ? {} : { transport: settings.transport }),
      ...(settings.nodeLeftDelayMs === undefined ? {} : { nodeLeftDelayMs: settings.nodeLeftDelayMs }),
      ...(settings.backups === undefined
        ? {}
        : { backupDirectory: settings.backups.directory, backupKeyPrefix: settings.backups.keyPrefix }),
      ...(bundles === null
        ? {}
        : {
            etcdTls: { ca: bundles.serverBundle.ca, cert: bundles.clientBundle.cert, key: bundles.clientBundle.key },
            etcdAuth: { username: 'root', password: ETCD_ROOT_PASSWORD },
            transportTls: {
              ca: bundles.serverBundle.ca,
              cert: bundles.serverBundle.cert,
              key: bundles.serverBundle.key,
            },
          }),
      ...settings.slotSettings?.[entry.slot],
    }
  }

  async function start(slot: number): Promise<void> {
    const entry = slotAt(slot)
    if (entry.child !== null) throw new Error(`Slot ${slot} is already running`)
    for (let attempt = 1; !(await startOnce(entry)); attempt++) {
      if (attempt === PORT_ATTEMPTS) throw new Error(`Slot ${slot} found no free port in ${PORT_ATTEMPTS} attempts`)
      entry.httpPort = await freePort()
      entry.transportPort = await freePort()
    }
  }

  async function startOnce(entry: Slot): Promise<boolean> {
    const slot = entry.slot
    const { NODE_OPTIONS: _inherited, ...parentEnv } = process.env
    const rust = settings.rustSlots?.includes(slot) === true
    const child = spawn(rust ? rustNodeBinary() : process.execPath, rust ? [] : [NODE_SCRIPT], {
      env: { ...parentEnv, NARSIL_FAULT_NODE: JSON.stringify(nodeSettings(entry)) },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    entry.child = child
    entry.output += `\n--- start ${new Date().toISOString()}\n`
    entry.exited = new Promise<void>(resolve => {
      child.once('close', (code, signal) => {
        entry.output += `\nexited with code ${code} and signal ${signal}\n`
        if (entry.child === child) entry.child = null
        resolve()
      })
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      entry.output += chunk.toString()
    })
    return await new Promise<boolean>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`Slot ${slot} did not start within ${READY_TIMEOUT_MS} ms: ${entry.output.slice(-4_000)}`))
      }, READY_TIMEOUT_MS)
      child.stdout?.on('data', (chunk: Buffer) => {
        entry.output += chunk.toString()
        const ready = READY_LINE.exec(entry.output.slice(entry.output.lastIndexOf('--- start')))
        if (ready !== null) {
          entry.nodeId = ready[1] ?? ''
          clearTimeout(timer)
          resolve(true)
        }
      })
      child.once('exit', code => {
        clearTimeout(timer)
        if (lostPortRace(entry.output.slice(entry.output.lastIndexOf('--- start')))) resolve(false)
        else reject(new Error(`Slot ${slot} exited with code ${code} before it started: ${entry.output.slice(-4_000)}`))
      })
    })
  }

  async function kill(slot: number): Promise<void> {
    const entry = slotAt(slot)
    const child = entry.child
    if (child === null) return
    child.kill('SIGCONT')
    child.kill('SIGKILL')
    await entry.exited
  }

  async function stopOne(entry: Slot): Promise<void> {
    const child = entry.child
    if (child === null) return
    child.kill('SIGCONT')
    child.kill('SIGTERM')
    const stopped = await Promise.race([entry.exited.then(() => true), sleep(STOP_TIMEOUT_MS).then(() => false)])
    if (!stopped) {
      child.kill('SIGKILL')
      await entry.exited
    }
  }

  return {
    nodes: slots.map(entry => ({
      slot: entry.slot,
      get base() {
        return `http://127.0.0.1:${entry.httpPort}`
      },
      get transportAddress() {
        return `127.0.0.1:${entry.transportPort}`
      },
      nodeId: () => entry.nodeId,
      running: () => entry.child !== null,
      output: () => entry.output,
    })),
    start,
    kill,
    async stop(slot) {
      const entry = slotAt(slot)
      await stopOne(entry)
      if (!entry.output.slice(entry.output.lastIndexOf('--- start')).includes('exited with code 0 and signal null'))
        throw new Error(`Slot ${slot} did not stop cleanly: ${entry.output.slice(-4_000)}`)
    },
    async wipe(slot) {
      const entry = slotAt(slot)
      if (entry.child !== null) throw new Error(`Slot ${slot} must stop before its data directory is wiped`)
      for (const name of await readdir(entry.directory)) {
        if (name !== NODE_ID_FILE) await rm(join(entry.directory, name), { recursive: true, force: true })
      }
    },
    pause(slot) {
      slotAt(slot).child?.kill('SIGSTOP')
    },
    resume(slot) {
      slotAt(slot).child?.kill('SIGCONT')
    },
    isolate(slot) {
      const entry = slotAt(slot)
      entry.transportProxy.cut()
      for (const proxy of entry.etcdProxies) proxy.cut()
    },
    blackhole(slot) {
      slotAt(slot).transportProxy.blackhole()
    },
    reconnect(slot) {
      const entry = slotAt(slot)
      entry.transportProxy.heal()
      for (const proxy of entry.etcdProxies) proxy.heal()
    },
    cutCoordinator(slot) {
      for (const proxy of slotAt(slot).etcdProxies) proxy.cut()
    },
    healCoordinator(slot) {
      for (const proxy of slotAt(slot).etcdProxies) proxy.heal()
    },
    async stopAll() {
      for (const entry of slots) await stopOne(entry)
    },
    async remove() {
      for (const entry of slots) {
        await kill(entry.slot)
        await entry.transportProxy.close()
        for (const proxy of entry.etcdProxies) await proxy.close()
        await rm(entry.directory, { recursive: true, force: true })
      }
    },
  }
}
