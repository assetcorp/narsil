import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const PACKAGE_NAME = '@delali/narsil-conformance'

function nameOfPackageIn(directory: string): string | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'))
    if (typeof parsed === 'object' && parsed !== null && 'name' in parsed && typeof parsed.name === 'string') {
      return parsed.name
    }
    return null
  } catch {
    return null
  }
}

function findPackageRoot(): string {
  let directory = dirname(fileURLToPath(import.meta.url))
  for (;;) {
    if (nameOfPackageIn(directory) === PACKAGE_NAME) return directory
    const parent = dirname(directory)
    if (parent === directory) throw new Error(`no directory above this module holds the ${PACKAGE_NAME} package`)
    directory = parent
  }
}

export const PACKAGE_ROOT = findPackageRoot()
