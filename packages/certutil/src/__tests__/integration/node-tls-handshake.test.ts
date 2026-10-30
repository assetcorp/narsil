import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  type Authority,
  createAuthority,
  createWorkspace,
  issueNodeCertificate,
  type NodeIdentity,
  removeWorkspace,
} from '../support/cli'
import { performMutualTlsHandshake, type TlsIdentity } from '../support/tls'

const UNTRUSTED_PEER_ERROR = /rsa routines|signature|certificate|unknown ca|alert|ECONNRESET|EPIPE|closed before/i

function identityFor(authority: Authority, node: NodeIdentity): TlsIdentity {
  return { ca: authority.certPem, cert: node.certPem, key: node.keyPem }
}

describe('certificates from the CLI in real Node TLS', () => {
  let root: string
  let authority: Authority
  let server: NodeIdentity
  let client: NodeIdentity
  let otherAuthority: Authority
  let foreignClient: NodeIdentity

  beforeAll(async () => {
    root = await createWorkspace()
    authority = await createAuthority(join(root, 'trusted'), 'Node TLS E2E CA')
    server = await issueNodeCertificate(authority, join(root, 'trusted'), 'node-tls-server', [
      '--ip',
      '127.0.0.1',
      '--dns',
      'localhost',
    ])
    client = await issueNodeCertificate(authority, join(root, 'trusted'), 'node-tls-client', [
      '--dns',
      'node-tls-client.local',
    ])
    otherAuthority = await createAuthority(join(root, 'foreign'), 'Node TLS E2E CA')
    foreignClient = await issueNodeCertificate(otherAuthority, join(root, 'foreign'), 'node-tls-client', [
      '--dns',
      'node-tls-client.local',
    ])
  })

  afterAll(async () => {
    await removeWorkspace(root)
  })

  it.each([
    ['an IP address', undefined],
    ['a DNS name', 'localhost'],
  ])('complete a mutual TLS handshake addressed by %s and exchange application data', async (_label, servername) => {
    const result = await performMutualTlsHandshake({
      server: identityFor(authority, server),
      client: identityFor(authority, client),
      servername,
    })

    expect(result.clientAuthorized).toBe(true)
    expect(result.serverAuthorized).toBe(true)
    expect(result.clientPeerCn).toBe('node-tls-server')
    expect(result.serverPeerCn).toBe('node-tls-client')
    expect(result.echoedPayload).toBe('server-ack')
  })

  it('are refused by a client when the server name is absent from the certificate', async () => {
    await expect(
      performMutualTlsHandshake({
        server: identityFor(authority, server),
        client: identityFor(authority, client),
        servername: 'other-node.cluster.local',
      }),
    ).rejects.toThrow(/does not match certificate's altnames/)
  })

  it('are refused by a server when the client holds a certificate from another CA with the same name', async () => {
    await expect(
      performMutualTlsHandshake({
        server: identityFor(authority, server),
        client: { ca: authority.certPem, cert: foreignClient.certPem, key: foreignClient.keyPem },
      }),
    ).rejects.toThrow(UNTRUSTED_PEER_ERROR)
  })

  it('are refused by a client that trusts only another CA', async () => {
    await expect(
      performMutualTlsHandshake({
        server: identityFor(authority, server),
        client: { ca: otherAuthority.certPem, cert: client.certPem, key: client.keyPem },
      }),
    ).rejects.toThrow(UNTRUSTED_PEER_ERROR)
  })
})
