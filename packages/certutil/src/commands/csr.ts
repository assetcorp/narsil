import { join } from 'node:path'
import type { Command } from 'commander'
import { loadClusterConfig } from '../batch/loader'
import { runBatchCsr } from '../batch/runner'
import { generateCsr } from '../crypto/csr'
import { formatError, formatGenerationText, formatSuccess } from '../output/formatter'
import { writeOutputFile } from '../output/writer'
import { ExitCode, type GenerationResult } from '../types'

export function registerCsrCommand(program: Command): void {
  program
    .command('csr')
    .description('Generate a certificate signing request and private key')
    .option('--cn <name>', 'Common name')
    .option('--ip <addresses...>', 'IP SANs')
    .option('--dns <names...>', 'DNS SANs')
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
  $ narsil-certutil csr --cn node1 --ip 10.0.0.1 --dns node1.cluster.local
  $ narsil-certutil csr --nodes cluster.yaml --out-dir ./csrs
  $ narsil-certutil csr --cn node1 --ip 10.0.0.1 --output json
  $ narsil-certutil csr --cn node1 --ip 10.0.0.1 --dry-run

Environment variables:
  NARSIL_CERT_OUT_DIR    Default value for --out-dir`,
    )
    .action(async (opts: CsrActionOptions) => {
      await runCsrAction(opts)
    })
}

interface CsrActionOptions {
  cn?: string
  ip?: string[]
  dns?: string[]
  keySize: string
  outDir: string
  output: string
  force: boolean
  dryRun: boolean
  nodes?: string
}

export async function runCsrAction(opts: CsrActionOptions): Promise<void> {
  const startTime = performance.now()
  const json = opts.output === 'json'

  try {
    const keySize = Number.parseInt(opts.keySize, 10)

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
          'Use --cn for a single CSR or --nodes for batch mode',
          startTime,
          json,
        )}\n`,
      )
      process.exitCode = ExitCode.BAD_ARGUMENTS
      return
    }

    if (opts.nodes) {
      await runCsrBatchMode(opts, keySize, startTime, json)
      return
    }

    const cn = opts.cn as string
    const result = generateCsr({
      cn,
      ipSans: opts.ip ?? [],
      dnsSans: opts.dns ?? [],
      keySize,
    })

    const csrPath = join(opts.outDir, `${cn}.csr`)
    const keyPath = join(opts.outDir, `${cn}.key`)

    if (opts.dryRun) {
      process.stderr.write('Dry run; no files written.\n')
      process.stderr.write(`  Would create: ${csrPath}\n`)
      process.stderr.write(`  Would create: ${keyPath}\n`)
      return
    }

    await writeOutputFile(csrPath, result.csrPem, opts.force)
    await writeOutputFile(keyPath, result.keyPem, opts.force)

    const genResult: GenerationResult = {
      files: [
        { path: csrPath, type: 'csr' },
        { path: keyPath, type: 'key' },
      ],
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

async function runCsrBatchMode(
  opts: CsrActionOptions,
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
      process.stderr.write(`  Would create: ${join(nodeDir, `${node.cn}.csr`)}\n`)
      process.stderr.write(`  Would create: ${join(nodeDir, `${node.cn}.key`)}\n`)
    }
    return
  }

  const results = await runBatchCsr(config, opts.outDir, opts.force, keySize)

  for (const batchResult of results) {
    const genResult: GenerationResult = {
      files: [
        {
          path: join(batchResult.outputDir, `${batchResult.cn}.csr`),
          type: 'csr',
        },
        {
          path: join(batchResult.outputDir, `${batchResult.cn}.key`),
          type: 'key',
        },
      ],
    }

    if (json) {
      process.stdout.write(`${formatSuccess(genResult, startTime, true)}\n`)
    } else {
      process.stderr.write(`${formatGenerationText(genResult)}\n`)
    }
  }
}
