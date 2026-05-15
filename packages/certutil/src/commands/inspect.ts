import { readFile } from 'node:fs/promises'
import type { Command } from 'commander'
import type forge from 'node-forge'
import { computeFingerprint } from '../crypto/fingerprint'
import { detectPemType, pemToCertificate, pemToCsr, pemToPrivateKey } from '../crypto/pem'
import { formatError, formatInspectText, formatSuccess } from '../output/formatter'
import { ExitCode, type InspectResult } from '../types'

export function registerInspectCommand(program: Command): void {
  program
    .command('inspect')
    .description('Inspect a PEM-encoded certificate, CSR, or key')
    .argument('<file>', 'Path to a PEM file')
    .option('--output <format>', 'Output format', 'text')
    .addHelpText(
      'after',
      `
Examples:
  $ narsil-certutil inspect ./certs/node1.crt
  $ narsil-certutil inspect ./certs/node1.key
  $ narsil-certutil inspect ./certs/node1.csr --output json`,
    )
    .action(async (file: string, opts: InspectActionOptions) => {
      await runInspectAction(file, opts)
    })
}

interface InspectActionOptions {
  output: string
}

export async function runInspectAction(file: string, opts: InspectActionOptions): Promise<void> {
  const startTime = performance.now()
  const json = opts.output === 'json'

  try {
    const pem = await readFile(file, 'utf-8')
    const pemType = detectPemType(pem)

    if (pemType === 'unknown') {
      process.stderr.write(
        `${formatError(
          'BAD_ARGUMENTS',
          'Unrecognized PEM format',
          'File must contain a certificate, private key, or CSR',
          startTime,
          json,
        )}\n`,
      )
      process.exitCode = ExitCode.BAD_ARGUMENTS
      return
    }

    let result: InspectResult

    if (pemType === 'certificate') {
      result = inspectCertificate(pem)
    } else if (pemType === 'csr') {
      result = inspectCsr(pem)
    } else {
      result = inspectKey(pem)
    }

    if (json) {
      process.stdout.write(`${formatSuccess(result, startTime, true)}\n`)
    } else {
      process.stdout.write(`${formatInspectText(result)}\n`)
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    process.stderr.write(`${formatError('GENERAL_ERROR', message, undefined, startTime, json)}\n`)
    process.exitCode = ExitCode.GENERAL_ERROR
  }
}

function extractSubject(attrs: forge.pki.CertificateField[]): Record<string, string> {
  const result: Record<string, string> = {}
  for (const attr of attrs) {
    const key = attr.shortName ?? attr.name ?? attr.type
    if (typeof key === 'string' && typeof attr.value === 'string') {
      result[key] = attr.value
    }
  }
  return result
}

function extractKeyUsage(cert: forge.pki.Certificate): string[] {
  const ext = cert.getExtension('keyUsage') as Record<string, unknown> | null
  if (ext === null) return []

  const usages: string[] = []
  if (ext.digitalSignature) usages.push('digitalSignature')
  if (ext.keyEncipherment) usages.push('keyEncipherment')
  if (ext.keyCertSign) usages.push('keyCertSign')
  if (ext.cRLSign) usages.push('cRLSign')
  if (ext.nonRepudiation) usages.push('nonRepudiation')
  if (ext.dataEncipherment) usages.push('dataEncipherment')
  if (ext.keyAgreement) usages.push('keyAgreement')
  return usages
}

function extractExtKeyUsage(cert: forge.pki.Certificate): string[] {
  const ext = cert.getExtension('extKeyUsage') as Record<string, unknown> | null
  if (ext === null) return []

  const usages: string[] = []
  if (ext.serverAuth) usages.push('serverAuth')
  if (ext.clientAuth) usages.push('clientAuth')
  return usages
}

function extractSans(cert: forge.pki.Certificate): { ipSans: string[]; dnsSans: string[] } {
  const ext = cert.getExtension('subjectAltName') as {
    altNames?: Array<{ type: number; value?: string; ip?: string }>
  } | null
  if (ext === null || ext.altNames === undefined) {
    return { ipSans: [], dnsSans: [] }
  }

  const ipSans: string[] = []
  const dnsSans: string[] = []
  for (const alt of ext.altNames) {
    if (alt.type === 7 && typeof alt.ip === 'string') {
      ipSans.push(alt.ip)
    } else if (alt.type === 2 && typeof alt.value === 'string') {
      dnsSans.push(alt.value)
    }
  }
  return { ipSans, dnsSans }
}

function extractCsrSans(csr: forge.pki.CertificateSigningRequest): { ipSans: string[]; dnsSans: string[] } {
  const attrs = (
    csr as unknown as {
      attributes?: Array<{
        name?: string
        extensions?: Array<{
          name?: string
          altNames?: Array<{
            type: number
            value?: string
            ip?: string
          }>
        }>
      }>
    }
  ).attributes

  if (attrs === undefined) {
    return { ipSans: [], dnsSans: [] }
  }

  for (const attr of attrs) {
    if (attr.name !== 'extensionRequest') continue
    if (attr.extensions === undefined) continue
    for (const ext of attr.extensions) {
      if (ext.name !== 'subjectAltName') continue
      if (ext.altNames === undefined) continue

      const ipSans: string[] = []
      const dnsSans: string[] = []
      for (const alt of ext.altNames) {
        if (alt.type === 7 && typeof alt.ip === 'string') {
          ipSans.push(alt.ip)
        } else if (alt.type === 2 && typeof alt.value === 'string') {
          dnsSans.push(alt.value)
        }
      }
      return { ipSans, dnsSans }
    }
  }
  return { ipSans: [], dnsSans: [] }
}

function inspectCertificate(pem: string): InspectResult {
  const cert = pemToCertificate(pem)
  const pubKey = cert.publicKey as forge.pki.rsa.PublicKey
  const sans = extractSans(cert)

  return {
    type: 'certificate',
    subject: extractSubject(cert.subject.attributes),
    issuer: extractSubject(cert.issuer.attributes),
    validFrom: cert.validity.notBefore.toISOString(),
    validTo: cert.validity.notAfter.toISOString(),
    expiresInDays: Math.floor((cert.validity.notAfter.getTime() - Date.now()) / (1000 * 60 * 60 * 24)),
    serialNumber: cert.serialNumber,
    keyUsage: extractKeyUsage(cert),
    extKeyUsage: extractExtKeyUsage(cert),
    ipSans: sans.ipSans,
    dnsSans: sans.dnsSans,
    fingerprint: computeFingerprint(cert),
    publicKeyBits: pubKey.n.bitLength(),
  }
}

function inspectCsr(pem: string): InspectResult {
  const csr = pemToCsr(pem)
  const pubKey = csr.publicKey as forge.pki.rsa.PublicKey
  const sans = extractCsrSans(csr)

  return {
    type: 'csr',
    subject: extractSubject(csr.subject.attributes),
    ipSans: sans.ipSans,
    dnsSans: sans.dnsSans,
    publicKeyBits: pubKey.n.bitLength(),
  }
}

function inspectKey(pem: string): InspectResult {
  const key = pemToPrivateKey(pem)
  return {
    type: 'key',
    publicKeyBits: key.n.bitLength(),
  }
}
