import { subscribe, unsubscribe } from 'node:diagnostics_channel'
import { Socket } from 'node:net'
import type { ChannelOptions, experimental } from '@grpc/grpc-js'
import type { GrpcModule } from './loader'

const PEER_DIAL_SCHEME = 'narsil-peer-dial'
const PEER_DIALS_OPTION = 'narsil.peer_dials'
const CLIENT_SOCKET_CHANNEL = 'net.client.socket'
const DEFAULT_SCHEME = 'dns'
const GRPC_TARGET_PATTERN = /^(?:([A-Za-z0-9+.-]+):)?(?:\/\/([^/]*)\/)?(.+)$/

interface Dial {
  controller: AbortController
  attempt: Set<Dial> | undefined
  closed: Promise<void> | undefined
}

export interface PeerDialing {
  readonly target: string
  readonly options: Record<string, number>
  beginAttempt(): void
  endAttempt(failed: boolean): void
  claimed(): void
}

const claimable = new Map<number, PeerChannelDials>()
const registeredModules = new WeakSet<object>()
let nextPeerId = 0

function registerPeerDialScheme(grpc: GrpcModule): void {
  const { createResolver, registerResolver, statusOrFromValue } = grpc.experimental
  if (registeredModules.has(grpc.experimental)) return
  registeredModules.add(grpc.experimental)

  registerResolver(
    PEER_DIAL_SCHEME,
    class PeerDialResolver implements experimental.Resolver {
      private readonly inner: experimental.Resolver

      constructor(target: experimental.GrpcUri, listener: experimental.ResolverListener, options: ChannelOptions) {
        const id: unknown = options[PEER_DIALS_OPTION]
        const peer = typeof id === 'number' ? claimable.get(id) : undefined
        const relay: experimental.ResolverListener = (endpoints, ...resolution) =>
          listener(
            peer === undefined || !endpoints.ok
              ? endpoints
              : statusOrFromValue(endpoints.value.map(endpoint => peer.endpointWithSignals(endpoint))),
            ...resolution,
          )
        this.inner = createResolver({ scheme: DEFAULT_SCHEME, path: target.path }, relay, options)
      }

      updateResolution(): void {
        this.inner.updateResolution()
      }

      destroy(): void {
        this.inner.destroy()
      }

      static getDefaultAuthority(target: experimental.GrpcUri): string {
        return target.path
      }
    },
  )
}

function isRegisteredScheme(grpc: GrpcModule, scheme: string, path: string): boolean {
  try {
    grpc.experimental.createResolver({ scheme, path }, () => true, {}).destroy()
    return true
  } catch {
    return false
  }
}

function resolvesThroughDefaultScheme(grpc: GrpcModule, target: string): boolean {
  const parsed = GRPC_TARGET_PATTERN.exec(target)
  if (parsed === null) return false
  const [, scheme, authority, path] = parsed
  if (scheme === undefined) return authority === undefined
  return path === undefined || !isRegisteredScheme(grpc, scheme, path)
}

class PeerChannelDials implements PeerDialing {
  readonly target: string
  readonly options: Record<string, number>
  private readonly id: number
  private readonly pool: PeerDials
  private attempt: Set<Dial> | undefined

  constructor(pool: PeerDials, id: number, target: string) {
    this.pool = pool
    this.id = id
    this.target = target
    this.options = { [PEER_DIALS_OPTION]: id }
  }

  beginAttempt(): void {
    this.attempt = new Set()
  }

  endAttempt(failed: boolean): void {
    const attempt = this.attempt
    this.attempt = undefined
    if (!failed || attempt === undefined) return
    for (const dial of attempt) dial.controller.abort()
  }

  claimed(): void {
    claimable.delete(this.id)
  }

  endpointWithSignals(endpoint: experimental.Endpoint): experimental.Endpoint {
    return { ...endpoint, addresses: endpoint.addresses.map(address => this.addressWithSignal(address)) }
  }

  private addressWithSignal(address: experimental.SubchannelAddress): experimental.SubchannelAddress {
    const withSignal = { ...address }
    let current: Dial | undefined
    Object.defineProperty(withSignal, 'signal', {
      enumerable: true,
      get: (): AbortSignal => {
        if (current === undefined) {
          const dial = this.pool.dial(this.attempt)
          current = dial
          queueMicrotask(() => {
            if (current === dial) current = undefined
          })
          return dial.controller.signal
        }
        return current.controller.signal
      },
    })
    return withSignal
  }
}

export class PeerDials {
  private readonly grpc: GrpcModule
  private readonly dials = new Set<Dial>()
  private awaitingSocket: Dial | undefined
  private closed = false

  constructor(grpc: GrpcModule) {
    this.grpc = grpc
    registerPeerDialScheme(grpc)
    subscribe(CLIENT_SOCKET_CHANNEL, this.onClientSocket)
  }

  forPeer(target: string): PeerDialing {
    const id = nextPeerId++
    const routed = resolvesThroughDefaultScheme(this.grpc, target) ? `${PEER_DIAL_SCHEME}:${target}` : target
    const peer = new PeerChannelDials(this, id, routed)
    claimable.set(id, peer)
    return peer
  }

  dial(attempt: Set<Dial> | undefined): Dial {
    const dial: Dial = { controller: new AbortController(), attempt, closed: undefined }
    if (this.closed) {
      dial.controller.abort()
      return dial
    }
    this.dials.add(dial)
    attempt?.add(dial)
    this.awaitingSocket = dial
    queueMicrotask(() => {
      if (this.awaitingSocket === dial) this.awaitingSocket = undefined
    })
    return dial
  }

  async shutdown(): Promise<void> {
    this.closed = true
    unsubscribe(CLIENT_SOCKET_CHANNEL, this.onClientSocket)
    const dials = [...this.dials]
    for (const dial of dials) dial.controller.abort()
    await Promise.all(dials.map(dial => dial.closed))
  }

  private readonly onClientSocket = (message: unknown): void => {
    const dial = this.awaitingSocket
    if (dial === undefined) return
    this.awaitingSocket = undefined
    if (typeof message !== 'object' || message === null || !('socket' in message)) return
    const { socket } = message
    if (!(socket instanceof Socket)) return
    dial.closed = new Promise<void>(resolve => {
      socket.once('close', () => {
        this.dials.delete(dial)
        dial.attempt?.delete(dial)
        resolve()
      })
    })
  }
}
