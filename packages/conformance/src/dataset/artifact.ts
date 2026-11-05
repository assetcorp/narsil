import { createHash } from 'node:crypto'
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import * as v from 'valibot'
import { ARTIFACT_FORMAT, ARTIFACT_MANIFEST, DATASET_ID, FETCHED_MARKER, MAX_ARTIFACT_FILE_BYTES } from './constants'
import { fetchBytes } from './http'

const MAX_MANIFEST_BYTES = 1_048_576
const SHA256_PATTERN = /^[0-9a-f]{64}$/
const SAFE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
const PARTIAL_SUFFIX = '.part'

const ArtifactFile = v.object({
  path: v.pipe(v.string(), v.regex(SAFE_NAME_PATTERN)),
  asset: v.pipe(v.string(), v.regex(SAFE_NAME_PATTERN)),
  sha256: v.pipe(v.string(), v.regex(SHA256_PATTERN)),
  bytes: v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(MAX_ARTIFACT_FILE_BYTES)),
})

const ArtifactManifest = v.looseObject({
  format: v.literal(ARTIFACT_FORMAT),
  dataset_id: v.literal(DATASET_ID),
  files: v.pipe(v.array(ArtifactFile), v.minLength(1)),
})

export const DatasetPin = v.object({
  url: v.pipe(v.string(), v.url(), v.startsWith('https://')),
  sha256: v.pipe(v.string(), v.regex(SHA256_PATTERN)),
})

export type DatasetPin = v.InferOutput<typeof DatasetPin>
export type ArtifactFile = v.InferOutput<typeof ArtifactFile>

export function sha256Of(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function manifestFrom(bytes: Uint8Array): v.InferOutput<typeof ArtifactManifest> {
  const result = v.safeParse(ArtifactManifest, JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)))
  if (!result.success) throw new Error(`the artifact manifest has an unexpected shape: ${v.summarize(result.issues)}`)
  const paths = new Set(result.output.files.map(file => file.path))
  if (paths.size !== result.output.files.length || paths.has(ARTIFACT_MANIFEST) || paths.has(FETCHED_MARKER)) {
    throw new Error('the artifact manifest lists a path twice or lists a reserved name')
  }
  return result.output
}

export async function writeArtifactManifest(
  directory: string,
  description: Record<string, unknown>,
): Promise<{ digest: string; files: ArtifactFile[] }> {
  const names = (await readdir(directory)).filter(name => name !== ARTIFACT_MANIFEST && name !== FETCHED_MARKER).sort()
  const files: ArtifactFile[] = []
  for (const name of names) {
    const bytes = await readFile(join(directory, name))
    files.push({ path: name, asset: name, sha256: sha256Of(bytes), bytes: bytes.byteLength })
  }
  const manifest = { format: ARTIFACT_FORMAT, dataset_id: DATASET_ID, ...description, files }
  const encoded = new TextEncoder().encode(`${JSON.stringify(manifest, null, 2)}\n`)
  await writeFile(join(directory, ARTIFACT_MANIFEST), encoded)
  return { digest: sha256Of(encoded), files }
}

async function fileDigestMatches(path: string, file: ArtifactFile): Promise<boolean> {
  const info = await stat(path).catch(() => null)
  if (info === null || info.size !== file.bytes) return false
  return sha256Of(await readFile(path)) === file.sha256
}

export async function verifiedArtifact(directory: string, pinnedDigest: string): Promise<ArtifactFile[]> {
  const manifestBytes = await readFile(join(directory, ARTIFACT_MANIFEST))
  const digest = sha256Of(manifestBytes)
  if (digest !== pinnedDigest) {
    throw new Error(`${ARTIFACT_MANIFEST} in ${directory} has SHA-256 ${digest}, while the pin gives ${pinnedDigest}`)
  }
  const { files } = manifestFrom(manifestBytes)
  for (const file of files) {
    if (!(await fileDigestMatches(join(directory, file.path), file))) {
      throw new Error(`${file.path} in ${directory} differs from the SHA-256 that the artifact manifest lists`)
    }
  }
  return files
}

async function writeAtomically(path: string, bytes: Uint8Array): Promise<void> {
  const partial = `${path}${PARTIAL_SUFFIX}`
  await writeFile(partial, bytes)
  await rename(partial, path)
}

export async function fetchArtifact(pin: DatasetPin, directory: string): Promise<ArtifactFile[]> {
  await mkdir(directory, { recursive: true })
  const markerPath = join(directory, FETCHED_MARKER)
  const marker = await readFile(markerPath, 'utf8').catch(() => null)
  if (marker !== null && marker.trim() === pin.sha256) {
    const verified = await verifiedArtifact(directory, pin.sha256).catch(() => null)
    if (verified !== null) return verified
  }
  await rm(markerPath, { force: true })
  const manifestBytes = await fetchBytes(`${pin.url}/${ARTIFACT_MANIFEST}`, MAX_MANIFEST_BYTES)
  const digest = sha256Of(manifestBytes)
  if (digest !== pin.sha256) {
    throw new Error(`the published ${ARTIFACT_MANIFEST} has SHA-256 ${digest}, while the pin gives ${pin.sha256}`)
  }
  const { files } = manifestFrom(manifestBytes)
  for (const file of files) {
    const path = join(directory, file.path)
    if (await fileDigestMatches(path, file)) continue
    const bytes = await fetchBytes(`${pin.url}/${file.asset}`, file.bytes)
    if (bytes.byteLength !== file.bytes || sha256Of(bytes) !== file.sha256) {
      throw new Error(`the published ${file.asset} differs from the SHA-256 that the artifact manifest lists`)
    }
    await writeAtomically(path, bytes)
  }
  await writeAtomically(join(directory, ARTIFACT_MANIFEST), manifestBytes)
  await writeFile(markerPath, `${pin.sha256}\n`)
  return files
}
