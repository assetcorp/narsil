import { connect, type Socket } from 'node:net'
import { connect as tlsConnect } from 'node:tls'
import { UNADDRESSABLE_TARGET_DETAIL } from '../constants'
import { TransportError, TransportErrorCodes } from '../types'
import { parseAddress } from './parse-address'
import { PeerConnection } from './peer-connection'
import type { TcpTransportConfig, TlsConfig } from './types'

export interface PeerLink {
  connection: Promise<PeerConnection>
  closed: Promise<void>
  usable(): boolean
  shutDown(): void
}

function addressOf(target: string): { host: string; port: number } {
  const [host, portText] = parseAddress(target)
  const port = Number.parseInt(portText, 10)
  if (Number.isNaN(port) || port < 0 || port > 65535) {
    throw new TransportError(TransportErrorCodes.CONNECT_FAILED, `Invalid port in target address '${target}'`, {
      target,
      [UNADDRESSABLE_TARGET_DETAIL]: true,
    })
  }
  return { host, port }
}

function connectFailed(target: string, reason: string, details: Record<string, unknown> = {}): TransportError {
  return new TransportError(TransportErrorCodes.CONNECT_FAILED, `Failed to connect to '${target}': ${reason}`, {
    target,
    ...details,
  })
}

function openSocket(target: string, tls: TlsConfig | undefined): Socket {
  const { host, port } = addressOf(target)
  try {
    const socket =
      tls === undefined
        ? connect({ host, port })
        : tlsConnect({
            host,
            port,
            cert: tls.cert,
            key: tls.key,
            ca: tls.ca,
            rejectUnauthorized: tls.rejectUnauthorized ?? true,
          })
    socket.setNoDelay(true)
    return socket
  } catch (error) {
    throw connectFailed(target, error instanceof Error ? error.message : String(error))
  }
}

export function dialPeer(target: string, config: TcpTransportConfig): PeerLink {
  const { tls, connectTimeout } = config
  const socket = openSocket(target, tls)
  const closed = new Promise<void>(resolve => {
    socket.once('close', () => resolve())
  })

  let established: PeerConnection | undefined
  let refuse: (error: TransportError) => void = () => undefined

  const connection = new Promise<PeerConnection>((resolve, reject) => {
    let settled = false
    refuse = error => {
      if (settled) return
      settled = true
      clearTimeout(connectTimer)
      socket.destroy()
      reject(error)
    }
    const failed = (reason: string, details: Record<string, unknown> = {}): void => {
      refuse(connectFailed(target, reason, details))
    }
    const connectTimer = setTimeout(() => {
      failed(`no connection was ready within ${connectTimeout}ms`, { timeoutMs: connectTimeout })
    }, connectTimeout)

    socket.on('error', error => {
      failed(error.message)
    })
    socket.once('close', () => {
      failed('the connection closed before it was ready')
    })
    socket.once(tls === undefined ? 'connect' : 'secureConnect', () => {
      if (settled) return
      settled = true
      clearTimeout(connectTimer)
      established = new PeerConnection(target, socket)
      resolve(established)
    })
  })

  return {
    connection,
    closed,
    usable: () => !socket.destroyed && !socket.writableEnded,
    shutDown() {
      if (established === undefined) {
        refuse(new TransportError(TransportErrorCodes.CONNECT_FAILED, 'Connection pool has been shut down', { target }))
      } else {
        established.close(new TransportError(TransportErrorCodes.PEER_UNAVAILABLE, 'Connection pool shutting down'))
      }
    },
  }
}
