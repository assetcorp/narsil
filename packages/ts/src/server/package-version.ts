import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const PUBLISHED_PACKAGE_NAME = '@delali/narsil'
const PACKAGE_MANIFEST_FILE = 'package.json'

let cachedVersion: string | null | undefined

function publishedVersionIn(directory: string): string | null | undefined {
  let text: string
  try {
    text = readFileSync(join(directory, PACKAGE_MANIFEST_FILE), 'utf8')
  } catch {
    return undefined
  }
  let manifest: unknown
  try {
    manifest = JSON.parse(text)
  } catch {
    return undefined
  }
  if (typeof manifest !== 'object' || manifest === null) return undefined
  const { name, version } = manifest as { name?: unknown; version?: unknown }
  if (name !== PUBLISHED_PACKAGE_NAME) return undefined
  return typeof version === 'string' && version.length > 0 ? version : null
}

function findPublishedVersion(): string | null {
  let directory: string
  try {
    directory = dirname(fileURLToPath(import.meta.url))
  } catch {
    return null
  }
  for (;;) {
    const found = publishedVersionIn(directory)
    if (found !== undefined) return found
    const parent = dirname(directory)
    if (parent === directory) return null
    directory = parent
  }
}

export function publishedPackageVersion(): string | null {
  if (cachedVersion === undefined) cachedVersion = findPublishedVersion()
  return cachedVersion
}
