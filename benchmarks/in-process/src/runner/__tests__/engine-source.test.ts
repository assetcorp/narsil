import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { engineSourceDiffersFromRelease, readEngineSourceIdentity } from '../engine-source'

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const REPO_ROOT = resolve(PACKAGE_ROOT, '..', '..')

const ENGINE_PREFIXES = [
  'packages/ts/src/',
  'packages/ts/package.json',
  'packages/ts/tsup.config.ts',
  'packages/ts/tsconfig.json',
  'packages/ts/examples/http-server/',
]

describe('readEngineSourceIdentity in this checkout', () => {
  it('reads the version packages/ts declares and names its release tag', () => {
    const declared = JSON.parse(readFileSync(resolve(REPO_ROOT, 'packages/ts/package.json'), 'utf8')).version
    const identity = readEngineSourceIdentity(PACKAGE_ROOT)

    expect(identity).not.toBeNull()
    expect(identity?.version).toBe(declared)
    expect(identity?.releaseTag).toBe(`narsil-ts@v${declared}`)
  })

  it('reports differences only from paths that reach the engine', () => {
    const identity = readEngineSourceIdentity(PACKAGE_ROOT)

    for (const path of identity?.changedPaths ?? []) {
      expect(ENGINE_PREFIXES.some(prefix => path.startsWith(prefix))).toBe(true)
      expect(path.startsWith('packages/ts/src/__tests__/')).toBe(false)
    }
  })

  it('agrees with its own changed-path list', () => {
    const identity = readEngineSourceIdentity(PACKAGE_ROOT)

    expect(identity?.matchesReleaseTag).toBe(identity?.releaseTagExists === true && identity?.changedPaths.length === 0)
    expect(engineSourceDiffersFromRelease(PACKAGE_ROOT)).toBe(identity?.matchesReleaseTag !== true)
  })

  it('reads the same answer from anywhere inside the repository', () => {
    const fromRoot = readEngineSourceIdentity(REPO_ROOT)
    const fromPackage = readEngineSourceIdentity(PACKAGE_ROOT)

    expect(fromRoot?.changedPaths).toEqual(fromPackage?.changedPaths)
    expect(fromRoot?.matchesReleaseTag).toBe(fromPackage?.matchesReleaseTag)
  })
})

describe('outside a repository', () => {
  let plain: string

  beforeEach(() => {
    plain = mkdtempSync(join(os.tmpdir(), 'narsil-engine-source-plain-'))
  })

  afterEach(() => {
    rmSync(plain, { recursive: true, force: true })
  })

  it('treats an impossible comparison as a difference', () => {
    expect(readEngineSourceIdentity(plain)).toBeNull()
    expect(engineSourceDiffersFromRelease(plain)).toBe(true)
  })
})
