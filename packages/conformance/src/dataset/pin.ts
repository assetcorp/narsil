import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import * as v from 'valibot'
import { DatasetPin } from './artifact'
import { DATASET_ID } from './constants'

export const PIN_PATH = fileURLToPath(new URL('../../dataset-pin.json', import.meta.url))
export const DEFAULT_CACHE_DIRECTORY = fileURLToPath(new URL('../../.dataset/', import.meta.url))
export const CACHE_DIRECTORY_ENV = 'NARSIL_CONFORMANCE_DATASET_DIR'
export const RELEASE_TAG = `dataset-${DATASET_ID.toLowerCase()
  .replace(/[^a-z0-9]+/g, '_')
  .replace(/^_+|_+$/g, '')}`
export const RELEASE_URL = `https://github.com/assetcorp/narsil/releases/download/${RELEASE_TAG}`

export async function readPin(): Promise<DatasetPin | null> {
  const text = await readFile(PIN_PATH, 'utf8').catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null
    throw error
  })
  if (text === null) return null
  const result = v.safeParse(DatasetPin, JSON.parse(text))
  if (!result.success) throw new Error(`${PIN_PATH} has an unexpected shape: ${v.summarize(result.issues)}`)
  return result.output
}

export function cacheDirectory(): string {
  return process.env[CACHE_DIRECTORY_ENV] ?? DEFAULT_CACHE_DIRECTORY
}
