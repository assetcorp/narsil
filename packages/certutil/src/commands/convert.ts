import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Command } from 'commander'
import { pemToPkcs12, pkcs12ToPem } from '../crypto/pkcs12'
import { formatError, formatSuccess } from '../output/formatter'
import { ensureDirectory, fileExists, writeOutputFile } from '../output/writer'
import { type ConvertResult, ExitCode } from '../types'

export function registerConvertCommand(program: Command): void {
  program
    .command('convert')
    .description('Convert between PEM and PKCS#12 formats')
    .option('--cert <path>', 'Certificate PEM file')
    .option('--key <path>', 'Private key PEM file')
    .option('--ca-cert <path>', 'CA certificate PEM file')
    .option('--p12 <path>', 'PKCS#12 input file')
    .requiredOption('--to <format>', 'Target format (pem or p12)')
    .option('--p12-password <password>', 'Password for PKCS#12', process.env.NARSIL_P12_PASSWORD)
    .option('--out-dir <dir>', 'Output directory', process.env.NARSIL_CERT_OUT_DIR ?? '.')
    .option('--output <format>', 'Output format', 'text')
    .option('--force', 'Overwrite existing files', false)
    .addHelpText(
      'after',
      `
Examples:
  $ narsil-certutil convert --cert node1.crt --key node1.key --to p12 --p12-password changeit
  $ narsil-certutil convert --cert node1.crt --key node1.key --ca-cert ca.crt --to p12 --p12-password changeit
  $ narsil-certutil convert --p12 node1.p12 --to pem --p12-password changeit --out-dir ./certs
  $ narsil-certutil convert --cert node1.crt --key node1.key --to p12 --p12-password changeit --output json

Environment variables:
  NARSIL_P12_PASSWORD    Default value for --p12-password
  NARSIL_CERT_OUT_DIR    Default value for --out-dir`,
    )
    .action(async (opts: ConvertActionOptions) => {
      await runConvertAction(opts)
    })
}

interface ConvertActionOptions {
  cert?: string
  key?: string
  caCert?: string
  p12?: string
  to: string
  p12Password?: string
  outDir: string
  output: string
  force: boolean
}

export async function runConvertAction(opts: ConvertActionOptions): Promise<void> {
  const startTime = performance.now()
  const json = opts.output === 'json'

  try {
    if (opts.to !== 'pem' && opts.to !== 'p12') {
      process.stderr.write(
        `${formatError('BAD_ARGUMENTS', `Invalid --to value: ${opts.to}`, 'Use pem or p12', startTime, json)}\n`,
      )
      process.exitCode = ExitCode.BAD_ARGUMENTS
      return
    }

    if (opts.p12Password === undefined) {
      process.stderr.write(
        `${formatError(
          'BAD_ARGUMENTS',
          'Password is required for PKCS#12 operations',
          'Use --p12-password or set NARSIL_P12_PASSWORD',
          startTime,
          json,
        )}\n`,
      )
      process.exitCode = ExitCode.BAD_ARGUMENTS
      return
    }

    let result: ConvertResult

    if (opts.to === 'p12') {
      result = await convertToPkcs12(opts, startTime, json)
    } else {
      result = await convertToPem(opts, startTime, json)
    }

    if (json) {
      process.stdout.write(`${formatSuccess(result, startTime, true)}\n`)
    } else {
      process.stderr.write('Converted files:\n')
      for (const file of result.files) {
        process.stderr.write(`  ${file}\n`)
      }
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    process.stderr.write(`${formatError('GENERAL_ERROR', message, undefined, startTime, json)}\n`)
    process.exitCode = ExitCode.GENERAL_ERROR
  }
}

async function convertToPkcs12(opts: ConvertActionOptions, startTime: number, json: boolean): Promise<ConvertResult> {
  if (opts.cert === undefined || opts.key === undefined) {
    process.stderr.write(
      `${formatError('BAD_ARGUMENTS', 'Converting to p12 requires --cert and --key', undefined, startTime, json)}\n`,
    )
    process.exitCode = ExitCode.BAD_ARGUMENTS
    throw new Error('Converting to p12 requires --cert and --key')
  }

  const certPem = await readFile(opts.cert, 'utf-8')
  const keyPem = await readFile(opts.key, 'utf-8')
  const caCertPem = opts.caCert !== undefined ? await readFile(opts.caCert, 'utf-8') : undefined

  const password = opts.p12Password as string
  const p12Bytes = pemToPkcs12(certPem, keyPem, password, caCertPem)

  const outPath = join(opts.outDir, 'certificate.p12')
  await ensureDirectory(opts.outDir)

  if (!opts.force) {
    const exists = await fileExists(outPath)
    if (exists) {
      throw new Error(`File already exists: ${outPath}. Use --force to overwrite.`)
    }
  }

  await writeFile(outPath, p12Bytes)

  return { format: 'p12', files: [outPath] }
}

async function convertToPem(opts: ConvertActionOptions, startTime: number, json: boolean): Promise<ConvertResult> {
  if (opts.p12 === undefined) {
    process.stderr.write(
      `${formatError('BAD_ARGUMENTS', 'Converting to PEM requires --p12', undefined, startTime, json)}\n`,
    )
    process.exitCode = ExitCode.BAD_ARGUMENTS
    throw new Error('Converting to PEM requires --p12')
  }

  const p12Bytes = new Uint8Array(await readFile(opts.p12))
  const password = opts.p12Password as string
  const result = pkcs12ToPem(p12Bytes, password)

  const files: string[] = []

  const certPath = join(opts.outDir, 'cert.pem')
  await writeOutputFile(certPath, result.certPem, opts.force)
  files.push(certPath)

  const keyPath = join(opts.outDir, 'key.pem')
  await writeOutputFile(keyPath, result.keyPem, opts.force)
  files.push(keyPath)

  for (let i = 0; i < result.caCertPems.length; i++) {
    const caPath = join(opts.outDir, `ca-${i}.pem`)
    await writeOutputFile(caPath, result.caCertPems[i], opts.force)
    files.push(caPath)
  }

  return { format: 'pem', files }
}
