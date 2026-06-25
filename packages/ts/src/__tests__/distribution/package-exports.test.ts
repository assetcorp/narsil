import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

interface PackageJson {
  exports: Record<string, { import: string; types: string } | unknown>
}

function readPackageJson(): PackageJson {
  return JSON.parse(readFileSync(new URL('../../../package.json', import.meta.url), 'utf8')) as PackageJson
}

function readSource(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), 'utf8')
}

describe('distribution package exports', () => {
  it('exposes coordinator adapters through tree-shakeable distribution subpaths', () => {
    const packageJson = readPackageJson()

    expect(packageJson.exports['./distribution/coordinator/in-memory']).toEqual({
      import: './dist/distribution/coordinator/in-memory.mjs',
      types: './dist/distribution/coordinator/in-memory.d.ts',
    })
    expect(packageJson.exports['./distribution/coordinator/etcd']).toEqual({
      import: './dist/distribution/coordinator/etcd.mjs',
      types: './dist/distribution/coordinator/etcd.d.ts',
    })
  })

  it('keeps distribution replication out of the root entry source', () => {
    const rootEntry = readSource('../../index.ts')
    const narsilEntry = readSource('../../narsil.ts')

    expect(rootEntry).not.toContain('createNarsilFromCore')
    expect(narsilEntry).not.toContain('distribution/replication')
    expect(narsilEntry).not.toContain('applyReplicationEntry')
  })
})
