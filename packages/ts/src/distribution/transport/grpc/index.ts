import type { ListenHandler } from '../types'
import { type NodeTransport, TransportError, TransportErrorCodes, type TransportMessage } from '../types'
import { GrpcClientPool } from './client'
import { loadGrpcModule } from './loader'
import { GrpcServerHost } from './server'
import { DEFAULT_GRPC_CONFIG, type GrpcTransportConfig } from './types'

export type { TlsConfig } from '../tcp/types'
export type { GrpcTransportConfig } from './types'

/**
 * Builds the gRPC transport a cluster node reaches its peers through,
 * implementing the `narsil.transport.v1.NodeTransport` service from the
 * cross-language specification.
 *
 * Each call carries one MessagePack-serialised message in a protobuf
 * envelope, so a node written in another language can join the same cluster
 * through its own gRPC stack. The transport listens on `config.host` and
 * `config.port`, and it dials a peer at the `host:port` address that peer
 * registered with the coordinator. Passing `config.tls` makes every
 * connection mutually authenticated: the server requires a client
 * certificate and both sides verify against the configured authority.
 *
 * The `@grpc/grpc-js` package is an optional peer dependency, and calling
 * this without it installed throws a `NarsilError` with the code
 * `TRANSPORT_DEPENDENCY_MISSING`.
 *
 * @param nodeId - The node this transport belongs to, used in error reports.
 * @param config - The listen address, the timeouts, and the TLS material.
 * @returns The transport, with `getPort` for reading the bound port.
 *
 * @public
 */
export async function createGrpcTransport(
  nodeId: string,
  config?: Partial<GrpcTransportConfig>,
): Promise<NodeTransport & { getPort(): number }> {
  const grpc = await loadGrpcModule()
  const resolvedConfig: GrpcTransportConfig = {
    ...DEFAULT_GRPC_CONFIG,
    ...config,
  }

  const pool = new GrpcClientPool(grpc, resolvedConfig)
  const server = new GrpcServerHost(grpc, resolvedConfig)
  let isShutdown = false

  function assertNotShutdown(): void {
    if (isShutdown) {
      throw new TransportError(
        TransportErrorCodes.PEER_UNAVAILABLE,
        `gRPC transport for node '${nodeId}' has been shut down`,
        { nodeId },
      )
    }
  }

  return {
    getPort(): number {
      return server.getPort()
    },

    async send(target: string, message: TransportMessage): Promise<TransportMessage> {
      assertNotShutdown()
      return pool.send(target, message)
    },

    async stream(target: string, message: TransportMessage, handler: (chunk: Uint8Array) => void): Promise<void> {
      assertNotShutdown()
      return pool.stream(target, message, handler)
    },

    async listen(handler: ListenHandler): Promise<() => void> {
      assertNotShutdown()
      return server.start(handler)
    },

    async shutdown(): Promise<void> {
      if (isShutdown) {
        return
      }
      isShutdown = true
      await Promise.all([pool.shutdown(), server.shutdown()])
    },
  }
}
