import { readFile } from 'node:fs/promises'
import type { Command } from 'commander'
import type forge from 'node-forge'
import { publicKeysMatch } from '../crypto/keys'
import { pemToCertificate, pemToPrivateKey } from '../crypto/pem'
import { formatError, formatSuccess, formatVerifyText } from '../output/formatter'
import { ExitCode, type VerifyResult } from '../types'

export function registerVerifyCommand(program: Command): void {
  program
    .command('verify')
    .description('Verify a certificate against a CA, key, or both')
    .requiredOption('--cert <path>', 'Certificate to verify')
    .option('--key <path>', 'Private key to match')
    .option('--ca-cert <path>', 'CA certificate for chain validation')
    .option('--output <format>', 'Output format', 'text')
    .addHelpText(
      'after',
      `
Examples:
  $ narsil-certutil verify --cert node1.crt --key node1.key --ca-cert ca.crt
  $ narsil-certutil verify --cert node1.crt --ca-cert ca.crt
  $ narsil-certutil verify --cert node1.crt --key node1.key
  $ narsil-certutil verify --cert node1.crt --key node1.key --output json`,
    )
    .action(async (opts: VerifyActionOptions) => {
      await runVerifyAction(opts)
    })
}

interface VerifyActionOptions {
  cert: string
  key?: string
  caCert?: string
  output: string
}

export async function runVerifyAction(opts: VerifyActionOptions): Promise<void> {
  const startTime = performance.now()
  const json = opts.output === 'json'

  try {
    const certPem = await readFile(opts.cert, 'utf-8')
    const cert = pemToCertificate(certPem)

    const result: VerifyResult = {
      certKeyMatch: null,
      chainValid: null,
      notExpired: true,
      keyUsageCorrect: false,
      mtlsReady: false,
      errors: [],
    }

    if (opts.key !== undefined) {
      const keyPem = await readFile(opts.key, 'utf-8')
      const key = pemToPrivateKey(keyPem)
      result.certKeyMatch = publicKeysMatch(cert, key)
      if (!result.certKeyMatch) {
        result.errors.push('Certificate does not match private key')
      }
    }

    if (opts.caCert !== undefined) {
      result.chainValid = await verifyChain(cert, opts.caCert)
      if (!result.chainValid) {
        result.errors.push('Certificate chain does not validate against CA')
      }
    }

    result.notExpired = cert.validity.notAfter.getTime() > Date.now()
    if (!result.notExpired) {
      result.errors.push('Certificate is expired')
    }

    result.keyUsageCorrect = checkKeyUsage(cert)
    if (!result.keyUsageCorrect) {
      result.errors.push('Key usage missing required fields')
    }

    result.mtlsReady = checkMtlsReady(cert)
    if (!result.mtlsReady) {
      result.errors.push('Missing serverAuth or clientAuth in extKeyUsage')
    }

    const allPassed =
      result.notExpired &&
      result.keyUsageCorrect &&
      result.mtlsReady &&
      result.certKeyMatch !== false &&
      result.chainValid !== false

    if (json) {
      process.stdout.write(`${formatSuccess(result, startTime, true)}\n`)
    } else {
      process.stdout.write(`${formatVerifyText(result)}\n`)
    }

    if (!allPassed) {
      process.exitCode = ExitCode.GENERAL_ERROR
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    process.stderr.write(`${formatError('GENERAL_ERROR', message, undefined, startTime, json)}\n`)
    process.exitCode = ExitCode.GENERAL_ERROR
  }
}

async function verifyChain(cert: forge.pki.Certificate, caCertPath: string): Promise<boolean> {
  const caCertPem = await readFile(caCertPath, 'utf-8')
  const caCert = pemToCertificate(caCertPem)
  try {
    return caCert.verify(cert)
  } catch {
    return false
  }
}

function checkKeyUsage(cert: forge.pki.Certificate): boolean {
  const ext = cert.getExtension('keyUsage') as Record<string, unknown> | null
  if (ext === null) return false
  return ext.digitalSignature === true && ext.keyEncipherment === true
}

function checkMtlsReady(cert: forge.pki.Certificate): boolean {
  const ext = cert.getExtension('extKeyUsage') as Record<string, unknown> | null
  if (ext === null) return false
  return ext.serverAuth === true && ext.clientAuth === true
}
