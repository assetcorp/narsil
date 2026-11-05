import { mkdtemp, rm } from 'node:fs/promises'
import { connect, createServer, type Server, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createNarsilClient, type NarsilClient } from '../../../client'
import { createNarsil, type Narsil } from '../../../narsil'
import type { RequestContext, RequestDenial, RequestGrant } from '../../../server'
import { createDeviceSync, type DeviceSync, type DeviceSyncOptions, type DeviceSyncStore } from '../../../sync/device'
import { createFilesystemDeviceStore } from '../../../sync/device/stores/filesystem'
import { startTestServer, type TestServer } from '../../server/helpers'

export const INDEX = 'alice'
export const DEVICE_TOKEN = 'alice-token'
export const ADMIN_TOKEN = 'admin-token'
export const SCHEMA = { schema: { title: 'string', body: 'string' } } as const
const SUBPROTOCOL = 'narsil.sync.v1'

export type Note = { title: string; body: string }

export function note(label: string): Note {
  return { title: `note ${label}`, body: `body of ${label} about ${label.length % 2 === 0 ? 'ferries' : 'tugs'}` }
}

function credentialOf(ctx: RequestContext): string | null {
  const bearer = ctx.headers.authorization
  if (bearer?.startsWith('Bearer ')) return bearer.slice('Bearer '.length)
  const offered = (ctx.headers['sec-websocket-protocol'] ?? '').split(',').map(value => value.trim())
  return offered.length > 1 && offered[0] === SUBPROTOCOL ? (offered[1] ?? null) : null
}

export function ownerOnly(ctx: RequestContext): RequestDenial | RequestGrant | undefined {
  const credential = credentialOf(ctx)
  if (credential === ADMIN_TOKEN) return undefined
  if (credential === DEVICE_TOKEN && ctx.path.startsWith(`/indexes/${INDEX}/`)) return undefined
  return { status: 403, code: 'FORBIDDEN', message: 'This credential does not own that index' }
}

export interface CutProxy {
  url: string
  target: string
  cut(): void
  heal(): void
  rangeRequests(): number
  downstreamBytes(): number
  throttle(bytesPerSecond: number | null): void
  close(): Promise<void>
}

export async function startCutProxy(target: string): Promise<CutProxy> {
  let current = new URL(target)
  let cut = false
  let ranges = 0
  let downstream = 0
  let bytesPerSecond: number | null = null
  const sockets = new Set<Socket>()
  const server: Server = createServer(incoming => {
    if (cut) {
      incoming.destroy()
      return
    }
    const outgoing = connect(Number(current.port), current.hostname)
    sockets.add(incoming)
    sockets.add(outgoing)
    incoming.on('data', chunk => {
      if (/\r\nrange: bytes=\d+-/i.test(chunk.toString('latin1'))) ranges += 1
    })
    outgoing.on('data', chunk => {
      downstream += chunk.byteLength
      if (bytesPerSecond === null) return
      outgoing.pause()
      setTimeout(() => outgoing.resume(), (chunk.byteLength / bytesPerSecond) * 1000)
    })
    incoming.pipe(outgoing)
    outgoing.pipe(incoming)
    const drop = (): void => {
      incoming.destroy()
      outgoing.destroy()
      sockets.delete(incoming)
      sockets.delete(outgoing)
    }
    incoming.on('error', drop)
    outgoing.on('error', drop)
    incoming.on('close', drop)
    outgoing.on('close', drop)
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('The proxy has no port')
  return {
    url: `http://127.0.0.1:${address.port}`,
    get target() {
      return current.toString()
    },
    set target(next: string) {
      current = new URL(next)
    },
    cut() {
      cut = true
      for (const socket of sockets) socket.destroy()
      sockets.clear()
    },
    heal() {
      cut = false
    },
    rangeRequests: () => ranges,
    downstreamBytes: () => downstream,
    throttle(next) {
      bytesPerSecond = next
    },
    async close() {
      for (const socket of sockets) socket.destroy()
      await new Promise<void>(resolve => server.close(() => resolve()))
    },
  }
}

export interface SyncServer {
  running: TestServer
  admin: NarsilClient
  proxy: CutProxy
  restart(): Promise<void>
  stop(): Promise<void>
}

export async function startSyncServer(directory: string): Promise<SyncServer> {
  const boot = (): Promise<TestServer> =>
    startTestServer({ sync: true, onRequest: ownerOnly }, { durability: { directory }, workers: { enabled: false } })
  let running = await boot()
  const proxy = await startCutProxy(running.base)
  const server: SyncServer = {
    running,
    admin: createNarsilClient({ url: running.base, headers: { authorization: `Bearer ${ADMIN_TOKEN}` } }),
    proxy,
    async restart() {
      await running.stop()
      running = await boot()
      server.running = running
      proxy.target = running.base
      server.admin = createNarsilClient({ url: running.base, headers: { authorization: `Bearer ${ADMIN_TOKEN}` } })
    },
    async stop() {
      await proxy.close()
      await running.stop()
    },
  }
  return server
}

export interface TestDevice {
  engine: Narsil
  store: DeviceSyncStore
  sync: DeviceSync
  errors: unknown[]
  close(): Promise<void>
}

export async function startDevice(
  url: string,
  directory: string,
  extra: Partial<DeviceSyncOptions> = {},
): Promise<TestDevice> {
  const engine = await createNarsil({
    durability: { directory: join(directory, 'engine') },
    workers: { enabled: false },
  })
  const store = await createFilesystemDeviceStore({ directory: join(directory, 'store') })
  const errors: unknown[] = []
  const sync = createDeviceSync({
    engine,
    indexName: INDEX,
    url,
    store,
    credential: () => DEVICE_TOKEN,
    onError: error => errors.push(error),
    ...extra,
  })
  await sync.start()
  return {
    engine,
    store,
    sync,
    errors,
    async close() {
      await sync.stop()
      await store.close()
      await engine.shutdown()
    },
  }
}

export async function temporaryDirectory(label: string): Promise<{ path: string; remove(): Promise<void> }> {
  const path = await mkdtemp(join(tmpdir(), `narsil-device-${label}-`))
  return { path, remove: () => rm(path, { recursive: true, force: true }) }
}

export async function documentsOf(engine: Narsil, index: string): Promise<Map<string, Note>> {
  const held = new Map<string, Note>()
  let cursor: string | undefined
  for (;;) {
    const page = await engine.listDocuments(index, { limit: 500, ...(cursor === undefined ? {} : { cursor }) })
    for (const item of page.documents) {
      const { title, body } = item.document as unknown as Note
      held.set(item.id, { title, body })
    }
    if (page.cursor === null) return held
    cursor = page.cursor
  }
}

export function sorted(documents: Map<string, Note>): Array<[string, Note]> {
  return [...documents.entries()].sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
}

export async function settledWithin(sync: DeviceSync, timeoutMs = 30_000): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | null = null
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`The device did not settle within ${timeoutMs} ms`)), timeoutMs)
  })
  try {
    await Promise.race([sync.settled(), deadline])
  } finally {
    if (timer !== null) clearTimeout(timer)
  }
}
