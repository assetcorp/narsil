import { readFile, writeFile } from 'node:fs/promises'
import forge from 'node-forge'
import { expect, it } from 'vitest'
import {
  createAuthority,
  createWorkspace,
  issueNodeCertificate,
  parseEnvelope,
  removeWorkspace,
  runCli,
} from '../support/cli'
import { performMutualTlsHandshake } from '../support/tls'

it('refuses a certificate outside the permitted DNS subtree of its CA, as Node TLS does', async () => {
  const directory = await createWorkspace()
  try {
    const authority = await createAuthority(directory, 'Constrained CA')
    const certificate = forge.pki.certificateFromPem(authority.certPem)
    const { create, Class, Type, toDer } = forge.asn1
    const subtree = create(Class.UNIVERSAL, Type.SEQUENCE, true, [
      create(Class.CONTEXT_SPECIFIC, 2, false, '.allowed.example'),
    ])
    certificate.setExtensions([
      ...certificate.extensions,
      {
        id: '2.5.29.30',
        value: toDer(
          create(Class.UNIVERSAL, Type.SEQUENCE, true, [create(Class.CONTEXT_SPECIFIC, 0, true, [subtree])]),
        ).getBytes(),
      },
    ])
    certificate.sign(forge.pki.privateKeyFromPem(authority.keyPem), forge.md.sha256.create())
    authority.certPem = forge.pki.certificateToPem(certificate)
    await writeFile(authority.certPath, authority.certPem)

    const allowed = await issueNodeCertificate(authority, directory, 'node.allowed.example', [
      '--dns',
      'node.allowed.example',
    ])
    const denied = await issueNodeCertificate(authority, directory, 'node.denied.example', [
      '--dns',
      'node.denied.example',
    ])
    for (const identity of [allowed, denied]) {
      const leaf = forge.pki.certificateFromPem(identity.certPem)
      for (const extension of leaf.extensions as Array<{ name?: string; critical?: boolean }>) {
        if (extension.name === 'subjectAltName' || extension.name === 'extKeyUsage') extension.critical = true
      }
      leaf.sign(forge.pki.privateKeyFromPem(authority.keyPem), forge.md.sha256.create())
      identity.certPem = forge.pki.certificateToPem(leaf)
      await writeFile(identity.certPath, identity.certPem)
    }
    const client = { ca: authority.certPem, cert: allowed.certPem, key: allowed.keyPem }
    await expect(
      performMutualTlsHandshake({ server: client, client, servername: 'node.allowed.example' }),
    ).resolves.toMatchObject({ clientAuthorized: true, serverAuthorized: true })
    await expect(
      performMutualTlsHandshake({
        server: { ca: authority.certPem, cert: denied.certPem, key: denied.keyPem },
        client,
        servername: 'node.denied.example',
      }),
    ).rejects.toThrow(/permitted subtree violation/)

    for (const [identity, expected] of [
      [allowed, true],
      [denied, false],
    ] as const) {
      const result = await runCli([
        'verify',
        '--cert',
        identity.certPath,
        '--ca-cert',
        authority.certPath,
        '--output',
        'json',
      ])
      expect(result.code).toBe(expected ? 0 : 1)
      expect(parseEnvelope<{ chainValid: boolean }>(result.stdout).data?.chainValid).toBe(expected)
      expect(result.stderr).not.toContain(await readFile(authority.keyPath, 'utf8'))
    }
  } finally {
    await removeWorkspace(directory)
  }
})
