import {
  createServer as createTlsServer,
  type TLSSocket,
  type Server as TlsServer,
  connect as tlsConnect,
} from 'node:tls'

const HANDSHAKE_TIMEOUT_MS = 5_000
const CLIENT_PAYLOAD = 'client-hello'
const SERVER_PAYLOAD = 'server-ack'

export interface TlsIdentity {
  ca: string
  cert?: string
  key?: string
  pfx?: Buffer
  passphrase?: string
}

export interface HandshakeOptions {
  server: TlsIdentity
  client: TlsIdentity
  servername?: string
}

export interface HandshakeResult {
  clientAuthorized: boolean
  clientPeerCn?: string
  echoedPayload: string
  serverAuthorized: boolean
  serverPeerCn?: string
}

async function listen(server: TlsServer): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      const address = server.address()
      if (address === null || typeof address === 'string') {
        reject(new Error('The TLS server did not bind to a TCP port'))
        return
      }
      resolve(address.port)
    })
  })
}

function peerCommonName(socket: TLSSocket): string | undefined {
  const name = socket.getPeerCertificate().subject?.CN
  return typeof name === 'string' ? name : undefined
}

export async function performMutualTlsHandshake(options: HandshakeOptions): Promise<HandshakeResult> {
  const sockets = new Set<TLSSocket>()
  const server = createTlsServer({ ...options.server, rejectUnauthorized: true, requestCert: true })
  let timeout: NodeJS.Timeout | undefined

  try {
    const port = await listen(server)

    return await new Promise<HandshakeResult>((resolve, reject) => {
      let serverAuthorized = false
      let serverPeerCn: string | undefined

      timeout = setTimeout(() => {
        reject(new Error('Timed out waiting for the TLS exchange to finish'))
      }, HANDSHAKE_TIMEOUT_MS)

      server.once('tlsClientError', reject)
      server.on('secureConnection', (socket: TLSSocket) => {
        sockets.add(socket)
        serverAuthorized = socket.authorized
        serverPeerCn = peerCommonName(socket)
        socket.setEncoding('utf8')
        socket.on('error', reject)
        socket.once('data', (payload: string) => {
          if (payload !== CLIENT_PAYLOAD) {
            reject(new Error(`The TLS server received an unexpected payload: ${payload}`))
            return
          }
          socket.end(SERVER_PAYLOAD)
        })
      })

      const client = tlsConnect({
        ...options.client,
        host: '127.0.0.1',
        port,
        rejectUnauthorized: true,
        servername: options.servername,
      })
      sockets.add(client)
      client.setEncoding('utf8')
      client.on('error', reject)
      client.once('close', () => {
        reject(new Error('The TLS connection closed before the server replied'))
      })
      client.once('secureConnect', () => {
        client.write(CLIENT_PAYLOAD)
      })
      client.once('data', (echoedPayload: string) => {
        resolve({
          clientAuthorized: client.authorized,
          clientPeerCn: peerCommonName(client),
          echoedPayload,
          serverAuthorized,
          serverPeerCn,
        })
      })
    })
  } finally {
    clearTimeout(timeout)
    for (const socket of sockets) {
      socket.destroy()
    }
    await new Promise<void>(resolve => {
      server.close(() => resolve())
    })
  }
}
