import {
  createServer as createTlsServer,
  type TLSSocket,
  type Server as TlsServer,
  connect as tlsConnect,
} from 'node:tls'
import { describe, expect, it } from 'vitest'
import { generateCaCertificate } from '../../crypto/ca'
import { generateNodeCertificate } from '../../crypto/certificate'

interface HandshakeResult {
  clientAuthorized: boolean
  clientPeerCn?: string
  echoedPayload: string
  serverAuthorized: boolean
  serverPeerCn?: string
}

async function listen(server: TlsServer): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    function handleError(error: Error): void {
      server.off('listening', handleListening)
      reject(error)
    }

    function handleListening(): void {
      server.off('error', handleError)
      const address = server.address()
      if (address === null || typeof address === 'string') {
        reject(new Error('TLS server did not bind to a TCP port'))
        return
      }
      resolve(address.port)
    }

    server.once('error', handleError)
    server.once('listening', handleListening)
    server.listen(0, '127.0.0.1')
  })
}

async function closeServer(server: TlsServer | null): Promise<void> {
  if (server === null || !server.listening) {
    return
  }

  await new Promise<void>(resolve => {
    server.close(() => resolve())
  })
}

async function closeSocket(socket: TLSSocket | null): Promise<void> {
  if (socket === null || socket.destroyed) {
    return
  }

  await new Promise<void>(resolve => {
    function handleClose(): void {
      resolve()
    }

    socket.once('close', handleClose)
    socket.end()
  })
}

async function performMutualTlsHandshake(): Promise<HandshakeResult> {
  const ca = generateCaCertificate({ name: 'Node TLS E2E CA', days: 3650, keySize: 2048 })
  const serverIdentity = generateNodeCertificate({
    caCertPem: ca.certPem,
    caKeyPem: ca.keyPem,
    cn: 'node-tls-server',
    ipSans: ['127.0.0.1'],
    dnsSans: ['localhost'],
    days: 365,
    keySize: 2048,
  })
  const clientIdentity = generateNodeCertificate({
    caCertPem: ca.certPem,
    caKeyPem: ca.keyPem,
    cn: 'node-tls-client',
    ipSans: [],
    dnsSans: ['node-tls-client.local'],
    days: 365,
    keySize: 2048,
  })

  let clientSocket: TLSSocket | null = null
  let server: TlsServer | null = null

  try {
    let clientAuthorized = false
    let clientPeerCn: string | undefined
    let failHandshake: ((error: Error) => void) | null = null
    let serverAuthorized = false
    let serverPeerCn: string | undefined

    function handleServerData(this: TLSSocket, data: string | Buffer): void {
      const payload = typeof data === 'string' ? data : data.toString('utf8')
      if (payload !== 'client-hello') {
        failHandshake?.(new Error(`Unexpected client payload during TLS smoke test: ${payload}`))
        return
      }
      this.end('server-ack')
    }

    function handleSecureConnection(socket: TLSSocket): void {
      socket.setEncoding('utf8')
      serverAuthorized = socket.authorized
      const peer = socket.getPeerCertificate()
      serverPeerCn = typeof peer.subject?.CN === 'string' ? peer.subject.CN : undefined

      if (!socket.authorized) {
        failHandshake?.(
          new Error(`Server rejected the certutil-generated client certificate: ${socket.authorizationError}`),
        )
        return
      }

      socket.once('data', handleServerData)
      socket.once('error', error => failHandshake?.(error))
    }

    server = createTlsServer(
      {
        ca: ca.certPem,
        cert: serverIdentity.certPem,
        key: serverIdentity.keyPem,
        rejectUnauthorized: true,
        requestCert: true,
      },
      handleSecureConnection,
    )

    const port = await listen(server)

    return await new Promise<HandshakeResult>((resolve, reject) => {
      let settled = false

      function resolveOnce(result: HandshakeResult): void {
        if (settled) {
          return
        }
        settled = true
        clearTimeout(timeout)
        resolve(result)
      }

      function rejectOnce(error: Error): void {
        if (settled) {
          return
        }
        settled = true
        clearTimeout(timeout)
        reject(error)
      }

      function handleTlsClientError(error: Error): void {
        rejectOnce(error)
      }

      function handleClientSecureConnect(): void {
        if (clientSocket === null) {
          rejectOnce(new Error('Client TLS socket was not created'))
          return
        }

        clientAuthorized = clientSocket.authorized
        const peer = clientSocket.getPeerCertificate()
        clientPeerCn = typeof peer.subject?.CN === 'string' ? peer.subject.CN : undefined

        if (!clientSocket.authorized) {
          rejectOnce(
            new Error(`Client rejected the certutil-generated server certificate: ${clientSocket.authorizationError}`),
          )
          return
        }

        clientSocket.write('client-hello')
      }

      function handleClientData(data: string | Buffer): void {
        const payload = typeof data === 'string' ? data : data.toString('utf8')
        resolveOnce({
          clientAuthorized,
          clientPeerCn,
          echoedPayload: payload,
          serverAuthorized,
          serverPeerCn,
        })
      }

      const timeout = setTimeout(() => {
        rejectOnce(new Error('Timed out waiting for a certutil-generated Node TLS handshake'))
      }, 5_000)

      failHandshake = rejectOnce
      server?.once('tlsClientError', handleTlsClientError)

      clientSocket = tlsConnect({
        ca: ca.certPem,
        cert: clientIdentity.certPem,
        host: '127.0.0.1',
        key: clientIdentity.keyPem,
        port,
        rejectUnauthorized: true,
        servername: 'localhost',
      })
      clientSocket.setEncoding('utf8')
      clientSocket.once('error', rejectOnce)
      clientSocket.once('secureConnect', handleClientSecureConnect)
      clientSocket.once('data', handleClientData)
    })
  } finally {
    await closeSocket(clientSocket)
    await closeServer(server)
  }
}

describe('certutil-generated certificates in Node TLS', () => {
  it('complete a real mutual TLS handshake and exchange application data', async () => {
    const result = await performMutualTlsHandshake()

    expect(result.clientAuthorized).toBe(true)
    expect(result.serverAuthorized).toBe(true)
    expect(result.clientPeerCn).toBe('node-tls-server')
    expect(result.serverPeerCn).toBe('node-tls-client')
    expect(result.echoedPayload).toBe('server-ack')
  })
})
