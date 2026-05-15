import { join } from 'node:path'
import type { Command } from 'commander'
import { generateCaCertificate } from '../crypto/ca'
import { formatError, formatGenerationText, formatSuccess } from '../output/formatter'
import { writeOutputFile } from '../output/writer'
import { ExitCode, type GenerationResult } from '../types'

export function registerCaCommand(program: Command): void {
  program
    .command('ca')
    .description('Generate a self-signed CA certificate and private key')
    .requiredOption('--name <name>', 'CA common name')
    .option('--days <n>', 'Validity period in days', '3650')
    .option('--key-size <bits>', 'RSA key size', '4096')
    .option('--out-dir <dir>', 'Output directory', process.env.NARSIL_CERT_OUT_DIR ?? '.')
    .option('--output <format>', 'Output format', 'text')
    .option('--force', 'Overwrite existing files', false)
    .option('--dry-run', 'Preview without writing files', false)
    .addHelpText(
      'after',
      `
Examples:
  $ narsil-certutil ca --name "Narsil CA" --out-dir ./certs
  $ narsil-certutil ca --name "Narsil CA" --days 1825 --key-size 2048
  $ narsil-certutil ca --name "Narsil CA" --output json --out-dir ./certs
  $ narsil-certutil ca --name "Narsil CA" --dry-run

Environment variables:
  NARSIL_CERT_OUT_DIR    Default value for --out-dir`,
    )
    .action(async (opts: CaActionOptions) => {
      await runCaAction(opts)
    })
}

interface CaActionOptions {
  name: string
  days: string
  keySize: string
  outDir: string
  output: string
  force: boolean
  dryRun: boolean
}

export async function runCaAction(opts: CaActionOptions): Promise<void> {
  const startTime = performance.now()
  const json = opts.output === 'json'

  try {
    const days = Number.parseInt(opts.days, 10)
    const keySize = Number.parseInt(opts.keySize, 10)

    if (Number.isNaN(days) || days <= 0) {
      process.stderr.write(
        `${formatError(
          'BAD_ARGUMENTS',
          `Invalid --days value: ${opts.days}`,
          'Provide a positive integer',
          startTime,
          json,
        )}\n`,
      )
      process.exitCode = ExitCode.BAD_ARGUMENTS
      return
    }

    if (keySize !== 2048 && keySize !== 4096) {
      process.stderr.write(
        formatError('BAD_ARGUMENTS', `Invalid --key-size value: ${opts.keySize}`, 'Use 2048 or 4096', startTime, json) +
          '\n',
      )
      process.exitCode = ExitCode.BAD_ARGUMENTS
      return
    }

    const result = generateCaCertificate({
      name: opts.name,
      days,
      keySize,
    })

    const certPath = join(opts.outDir, 'ca.crt')
    const keyPath = join(opts.outDir, 'ca.key')

    if (opts.dryRun) {
      process.stderr.write('Dry run; no files written.\n')
      process.stderr.write(`  Would create: ${certPath}\n`)
      process.stderr.write(`  Would create: ${keyPath}\n`)
      return
    }

    await writeOutputFile(certPath, result.certPem, opts.force)
    await writeOutputFile(keyPath, result.keyPem, opts.force)

    const genResult: GenerationResult = {
      files: [
        { path: certPath, type: 'certificate' },
        { path: keyPath, type: 'key' },
      ],
      fingerprint: result.fingerprint,
      expiresAt: new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString(),
    }

    if (json) {
      process.stdout.write(`${formatSuccess(genResult, startTime, true)}\n`)
    } else {
      process.stderr.write(`${formatGenerationText(genResult)}\n`)
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    process.stderr.write(`${formatError('GENERAL_ERROR', message, undefined, startTime, json)}\n`)
    process.exitCode = ExitCode.GENERAL_ERROR
  }
}
