import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { BEIR_DATASETS, type BeirDatasetName } from './types'

const __dirname = dirname(fileURLToPath(import.meta.url))

interface RegistryEntry {
  url: string
  license: string
}

const BEIR_BASE = 'https://public.ukp.informatik.tu-darmstadt.de/thakur/BEIR/datasets'

export const REGISTRY: Record<BeirDatasetName, RegistryEntry> = {
  scifact: { url: `${BEIR_BASE}/scifact.zip`, license: 'CC BY-NC 2.0' },
  nfcorpus: { url: `${BEIR_BASE}/nfcorpus.zip`, license: 'CC BY-SA 4.0' },
  fiqa: { url: `${BEIR_BASE}/fiqa.zip`, license: 'CC BY-SA 4.0' },
}

export const DOCUMENT_TEXT_RULE = "title + ' ' + text (both trimmed; the non-empty side alone when one is empty)"

export const FINGERPRINT_ALGORITHM = 'sha256/len-framed/id-byte-sorted/v1'

export function assertDatasetName(name: string): BeirDatasetName {
  if ((BEIR_DATASETS as readonly string[]).includes(name)) {
    return name as BeirDatasetName
  }
  throw new Error(`unknown BEIR dataset '${name}'; known datasets: ${BEIR_DATASETS.join(', ')}`)
}

const packageRoot = resolve(__dirname, '..', '..', '..')

export function datasetsCacheDir(): string {
  return resolve(packageRoot, '..', 'datasets')
}

export function archiveCachePath(name: BeirDatasetName): string {
  return resolve(datasetsCacheDir(), `${name}.zip`)
}

export function manifestPath(name: BeirDatasetName): string {
  return resolve(__dirname, 'manifests', `${name}.json`)
}

export function archiveMemberPrefix(name: BeirDatasetName): string {
  return `${name}/`
}
