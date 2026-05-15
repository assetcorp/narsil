import { join } from 'node:path'
import { generateNodeCertificate } from '../crypto/certificate'
import { generateCsr } from '../crypto/csr'
import { writeOutputFile } from '../output/writer'
import type { ClusterConfig } from '../types'

export interface BatchCertResult {
  cn: string
  certPem: string
  keyPem: string
  fingerprint: string
  outputDir: string
}

export interface BatchCsrResult {
  cn: string
  csrPem: string
  keyPem: string
  outputDir: string
}

function resolveKeySize(
  nodeKeySize: 2048 | 4096 | undefined,
  defaultsKeySize: 2048 | 4096 | undefined,
  paramKeySize: 2048 | 4096,
): 2048 | 4096 {
  return nodeKeySize ?? defaultsKeySize ?? paramKeySize
}

function resolveDays(nodeDays: number | undefined, defaultsDays: number | undefined, paramDays: number): number {
  return nodeDays ?? defaultsDays ?? paramDays
}

export async function runBatchCert(
  config: ClusterConfig,
  caCertPem: string,
  caKeyPem: string,
  baseOutputDir: string,
  overwrite: boolean,
  defaultDays: number,
  defaultKeySize: 2048 | 4096,
): Promise<BatchCertResult[]> {
  const results: BatchCertResult[] = []

  for (const node of config.nodes) {
    const keySize = resolveKeySize(undefined, config.defaults?.keySize, defaultKeySize)
    const days = resolveDays(undefined, config.defaults?.days, defaultDays)

    const generated = generateNodeCertificate({
      caCertPem,
      caKeyPem,
      cn: node.cn,
      ipSans: node.ip ?? [],
      dnsSans: node.dns ?? [],
      days,
      keySize,
    })

    const nodeDir = join(baseOutputDir, node.cn)
    const certPath = join(nodeDir, `${node.cn}.crt`)
    const keyPath = join(nodeDir, `${node.cn}.key`)

    await writeOutputFile(certPath, generated.certPem, overwrite)
    await writeOutputFile(keyPath, generated.keyPem, overwrite)

    results.push({
      cn: node.cn,
      certPem: generated.certPem,
      keyPem: generated.keyPem,
      fingerprint: generated.fingerprint,
      outputDir: nodeDir,
    })
  }

  return results
}

export async function runBatchCsr(
  config: ClusterConfig,
  baseOutputDir: string,
  overwrite: boolean,
  defaultKeySize: 2048 | 4096,
): Promise<BatchCsrResult[]> {
  const results: BatchCsrResult[] = []

  for (const node of config.nodes) {
    const keySize = resolveKeySize(undefined, config.defaults?.keySize, defaultKeySize)

    const generated = generateCsr({
      cn: node.cn,
      ipSans: node.ip ?? [],
      dnsSans: node.dns ?? [],
      keySize,
    })

    const nodeDir = join(baseOutputDir, node.cn)
    const csrPath = join(nodeDir, `${node.cn}.csr`)
    const keyPath = join(nodeDir, `${node.cn}.key`)

    await writeOutputFile(csrPath, generated.csrPem, overwrite)
    await writeOutputFile(keyPath, generated.keyPem, overwrite)

    results.push({
      cn: node.cn,
      csrPem: generated.csrPem,
      keyPem: generated.keyPem,
      outputDir: nodeDir,
    })
  }

  return results
}
