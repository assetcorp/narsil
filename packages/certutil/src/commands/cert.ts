import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Command } from 'commander'
import { loadClusterConfig } from '../batch/loader'
import { runBatchCert } from '../batch/runner'
import { generateNodeCertificate } from '../crypto/certificate'
import { computeFingerprint } from '../crypto/fingerprint'
import { pemToCertificate } from '../crypto/pem'
import { formatError, formatGenerationText, formatSuccess } from '../output/formatter'
import { fileExists, writeOutputFile } from '../output/writer'
import { ExitCode, type GenerationResult } from '../types'

export function registerCertCommand(program: Command): void {
  program
    .command('cert')
    .description('Generate a node certificate signed by an existing CA')
    .option('--cn <name>', 'Node common name')
    .requiredOption('--ca-cert <path>', 'Path to CA certificate', process.env.NARSIL_CA_CERT)
    .requiredOption('--ca-key <path>', 'Path to CA key', process.env.NARSIL_CA_KEY)
    .option('--ip <addresses...>', 'IP SANs')
    .option('--dns <names...>', 'DNS SANs')
    .option('--days <n>', 'Validity period in days', '365')
    .option('--key-size <bits>', 'RSA key size', '2048')
    .option('--out-dir <dir>', 'Output directory', process.env.NARSIL_CERT_OUT_DIR ?? '.')
    .option('--output <format>', 'Output format', 'text')
    .option('--force', 'Overwrite existing files', false)
    .option('--dry-run', 'Preview without writing files', false)
    .option('--nodes <path>', 'Path to cluster YAML/JSON for batch mode')
    .addHelpText(
      'after',
      `
Examples:
  $ narsil-certutil cert --cn node1 --ca-cert ca.crt --ca-key ca.key --ip 10.0.0.1
  $ narsil-certutil cert --cn node1 --ca-cert ca.crt --ca-key ca.key --ip 10.0.0.1 --dns node1.local
  $ narsil-certutil cert --ca-cert ca.crt --ca-key ca.key --nodes cluster.yaml --out-dir ./certs
  $ narsil-certutil cert --cn node1 --ca-cert ca.crt --ca-key ca.key --dry-run

Environment variables:
  NARSIL_CA_CERT         Default value for --ca-cert
  NARSIL_CA_KEY          Default value for --ca-key
  NARSIL_CERT_OUT_DIR    Default value for --out-dir`,
    )
    .action(async (opts: CertActionOptions) => {
      await runCertAction(opts)
    })
}

interface CertActionOptions {
  cn?: string
  caCert: string
  caKey: string
  ip?: string[]
  dns?: string[]
  days: string
  keySize: string
  outDir: string
  output: string
  force: boolean
  dryRun: boolean
  nodes?: string
}

export async function runCertAction(opts: CertActionOptions): Promise<void> {
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

    if (!opts.cn && !opts.nodes) {
      process.stderr.write(
        `${formatError(
          'BAD_ARGUMENTS',
          'Provide either --cn or --nodes',
          'Use --cn for a single cert or --nodes for batch mode',
          startTime,
          json,
        )}\n`,
      )
      process.exitCode = ExitCode.BAD_ARGUMENTS
      return
    }

    await validateFileReadable(opts.caCert, '--ca-cert')
    await validateFileReadable(opts.caKey, '--ca-key')

    const caCertPem = await readFile(opts.caCert, 'utf-8')
    const caKeyPem = await readFile(opts.caKey, 'utf-8')

    if (opts.nodes) {
      await runBatchMode(opts, caCertPem, caKeyPem, days, keySize, startTime, json)
      return
    }

    const cn = opts.cn as string
    const result = generateNodeCertificate({
      caCertPem,
      caKeyPem,
      cn,
      ipSans: opts.ip ?? [],
      dnsSans: opts.dns ?? [],
      days,
      keySize,
    })

    const certPath = join(opts.outDir, `${cn}.crt`)
    const keyPath = join(opts.outDir, `${cn}.key`)

    if (opts.dryRun) {
      process.stderr.write('Dry run; no files written.\n')
      process.stderr.write(`  Would create: ${certPath}\n`)
      process.stderr.write(`  Would create: ${keyPath}\n`)
      return
    }

    await writeOutputFile(certPath, result.certPem, opts.force)
    await writeOutputFile(keyPath, result.keyPem, opts.force)

    const cert = pemToCertificate(result.certPem)
    const genResult: GenerationResult = {
      files: [
        { path: certPath, type: 'certificate' },
        { path: keyPath, type: 'key' },
      ],
      fingerprint: computeFingerprint(cert),
      expiresAt: cert.validity.notAfter.toISOString(),
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

async function validateFileReadable(filePath: string, flag: string): Promise<void> {
  const exists = await fileExists(filePath)
  if (!exists) {
    throw new Error(`File not found for ${flag}: ${filePath}`)
  }
}

async function runBatchMode(
  opts: CertActionOptions,
  caCertPem: string,
  caKeyPem: string,
  days: number,
  keySize: 2048 | 4096,
  startTime: number,
  json: boolean,
): Promise<void> {
  const nodesPath = opts.nodes as string
  const config = await loadClusterConfig(nodesPath)

  if (opts.dryRun) {
    process.stderr.write('Dry run; no files written.\n')
    for (const node of config.nodes) {
      const nodeDir = join(opts.outDir, node.cn)
      process.stderr.write(`  Would create: ${join(nodeDir, `${node.cn}.crt`)}\n`)
      process.stderr.write(`  Would create: ${join(nodeDir, `${node.cn}.key`)}\n`)
    }
    return
  }

  const results = await runBatchCert(config, caCertPem, caKeyPem, opts.outDir, opts.force, days, keySize)

  for (const batchResult of results) {
    const genResult: GenerationResult = {
      files: [
        {
          path: join(batchResult.outputDir, `${batchResult.cn}.crt`),
          type: 'certificate',
        },
        {
          path: join(batchResult.outputDir, `${batchResult.cn}.key`),
          type: 'key',
        },
      ],
      fingerprint: batchResult.fingerprint,
    }

    if (json) {
      process.stdout.write(`${formatSuccess(genResult, startTime, true)}\n`)
    } else {
      process.stderr.write(`${formatGenerationText(genResult)}\n`)
    }
  }
}
