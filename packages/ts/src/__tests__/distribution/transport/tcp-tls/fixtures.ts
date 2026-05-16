import { generate } from 'selfsigned'
import type { TransportMessage } from '../../../../distribution/transport'
import { ClusterMessageTypes } from '../../../../distribution/transport'
import { createTcpTransport, type TlsConfig } from '../../../../distribution/transport/tcp'

export interface CertBundle {
  cert: string
  key: string
  ca: string
}

export type ListenHandler = (message: TransportMessage, respond: (r: TransportMessage) => void) => void | Promise<void>

export interface TlsBundles {
  serverBundle: CertBundle
  clientBundle: CertBundle
  rogueBundle: CertBundle
  rotatedClientBundle: CertBundle
  rotatedServerBundle: CertBundle
}

export function makeMessage(overrides: Partial<TransportMessage> = {}): TransportMessage {
  return {
    type: ClusterMessageTypes.PING,
    sourceId: 'tls-node-a',
    requestId: 'tls-req-001',
    payload: new Uint8Array([1, 2, 3]),
    ...overrides,
  }
}

export function echoHandler(serverId: string): ListenHandler {
  return (message, respond) => {
    respond({
      type: ClusterMessageTypes.PONG,
      sourceId: serverId,
      requestId: message.requestId,
      payload: message.payload,
    })
  }
}

export function makeTlsConfig(bundle: CertBundle): TlsConfig {
  return { cert: bundle.cert, key: bundle.key, ca: bundle.ca }
}

export type TransportPair = {
  server: ReturnType<typeof createTcpTransport>
  client: ReturnType<typeof createTcpTransport>
  port: number
  cleanup: () => Promise<void>
}

export async function createTlsPair(
  handler: ListenHandler,
  serverTls?: TlsConfig,
  clientTls?: TlsConfig,
): Promise<TransportPair> {
  const server = createTcpTransport('tls-server', {
    host: '127.0.0.1',
    port: 0,
    requestTimeout: 5_000,
    connectTimeout: 3_000,
    snapshotTimeout: 10_000,
    tls: serverTls,
  })
  await server.listen(handler)
  const port = server.getPort()
  const client = createTcpTransport('tls-client', {
    host: '127.0.0.1',
    port: 0,
    requestTimeout: 5_000,
    connectTimeout: 3_000,
    snapshotTimeout: 10_000,
    tls: clientTls,
  })
  return {
    server,
    client,
    port,
    cleanup: async () => {
      await client.shutdown()
      await server.shutdown()
    },
  }
}

let cachedBundles: TlsBundles | undefined

export async function generateTlsBundles(): Promise<TlsBundles> {
  if (cachedBundles) return cachedBundles

  const caResult = await generate([{ name: 'commonName', value: 'Narsil Test CA' }], {
    keySize: 2048,
    algorithm: 'sha256',
    extensions: [
      { name: 'basicConstraints', cA: true, critical: true },
      { name: 'keyUsage', keyCertSign: true, cRLSign: true, critical: true },
    ],
  })
  const caCert = caResult.cert
  const caKey = caResult.private

  const serverResult = await generate([{ name: 'commonName', value: 'narsil-server' }], {
    keySize: 2048,
    algorithm: 'sha256',
    ca: { key: caKey, cert: caCert },
    extensions: [
      { name: 'basicConstraints', cA: false },
      { name: 'keyUsage', digitalSignature: true, keyEncipherment: true },
      { name: 'extKeyUsage', serverAuth: true, clientAuth: true },
      { name: 'subjectAltName', altNames: [{ type: 7, ip: '127.0.0.1' }] },
    ],
  })

  const clientResult = await generate([{ name: 'commonName', value: 'narsil-client' }], {
    keySize: 2048,
    algorithm: 'sha256',
    ca: { key: caKey, cert: caCert },
    extensions: [
      { name: 'basicConstraints', cA: false },
      { name: 'keyUsage', digitalSignature: true, keyEncipherment: true },
      { name: 'extKeyUsage', clientAuth: true },
    ],
  })

  const serverBundle: CertBundle = { cert: serverResult.cert, key: serverResult.private, ca: caCert }
  const clientBundle: CertBundle = { cert: clientResult.cert, key: clientResult.private, ca: caCert }

  const rogueCA = await generate([{ name: 'commonName', value: 'Rogue CA' }], {
    keySize: 2048,
    algorithm: 'sha256',
    extensions: [
      { name: 'basicConstraints', cA: true, critical: true },
      { name: 'keyUsage', keyCertSign: true, cRLSign: true, critical: true },
    ],
  })
  const rogueCert = await generate([{ name: 'commonName', value: 'rogue-node' }], {
    keySize: 2048,
    algorithm: 'sha256',
    ca: { key: rogueCA.private, cert: rogueCA.cert },
    extensions: [
      { name: 'basicConstraints', cA: false },
      { name: 'keyUsage', digitalSignature: true, keyEncipherment: true },
      { name: 'extKeyUsage', clientAuth: true },
    ],
  })
  const rogueBundle: CertBundle = { cert: rogueCert.cert, key: rogueCert.private, ca: rogueCA.cert }

  const rotatedCA = await generate([{ name: 'commonName', value: 'Rotated Test CA' }], {
    keySize: 2048,
    algorithm: 'sha256',
    extensions: [
      { name: 'basicConstraints', cA: true, critical: true },
      { name: 'keyUsage', keyCertSign: true, cRLSign: true, critical: true },
    ],
  })
  const rotatedServer = await generate([{ name: 'commonName', value: 'rotated-narsil-server' }], {
    keySize: 2048,
    algorithm: 'sha256',
    ca: { key: rotatedCA.private, cert: rotatedCA.cert },
    extensions: [
      { name: 'basicConstraints', cA: false },
      { name: 'keyUsage', digitalSignature: true, keyEncipherment: true },
      { name: 'extKeyUsage', serverAuth: true, clientAuth: true },
      { name: 'subjectAltName', altNames: [{ type: 7, ip: '127.0.0.1' }] },
    ],
  })
  const rotatedClient = await generate([{ name: 'commonName', value: 'rotated-narsil-client' }], {
    keySize: 2048,
    algorithm: 'sha256',
    ca: { key: rotatedCA.private, cert: rotatedCA.cert },
    extensions: [
      { name: 'basicConstraints', cA: false },
      { name: 'keyUsage', digitalSignature: true, keyEncipherment: true },
      { name: 'extKeyUsage', clientAuth: true },
    ],
  })
  const rotatedServerBundle: CertBundle = {
    cert: rotatedServer.cert,
    key: rotatedServer.private,
    ca: rotatedCA.cert,
  }
  const rotatedClientBundle: CertBundle = {
    cert: rotatedClient.cert,
    key: rotatedClient.private,
    ca: rotatedCA.cert,
  }

  cachedBundles = {
    serverBundle,
    clientBundle,
    rogueBundle,
    rotatedClientBundle,
    rotatedServerBundle,
  }
  return cachedBundles
}
