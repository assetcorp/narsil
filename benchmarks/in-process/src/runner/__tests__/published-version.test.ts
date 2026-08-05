import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  assertPublishedEngineSource,
  engineSourceDiffersFromRelease,
  PublishedVersionError,
  readEngineSourceIdentity,
} from '../published-version'

const VERSION = '1.2.3'
const TAG = `narsil-ts@v${VERSION}`

function git(repo: string, args: string[]): void {
  execFileSync('git', ['-c', 'user.email=bench@example.test', '-c', 'user.name=bench', ...args], {
    cwd: repo,
    stdio: 'ignore',
  })
}

function write(repo: string, relative: string, contents: string): void {
  const path = resolve(repo, relative)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, contents)
}

function codeOf(run: () => unknown): string {
  try {
    run()
  } catch (error) {
    if (error instanceof PublishedVersionError) return error.code
    throw error
  }
  throw new Error('expected a PublishedVersionError')
}

describe('readEngineSourceIdentity', () => {
  let repo: string

  beforeEach(() => {
    repo = mkdtempSync(join(os.tmpdir(), 'narsil-published-version-'))
    git(repo, ['init', '-q'])
    write(repo, 'packages/ts/package.json', `{"name":"@delali/narsil","version":"${VERSION}"}\n`)
    write(repo, 'packages/ts/src/index.ts', 'export const VERSION = 1\n')
    write(repo, 'packages/ts/tsup.config.ts', 'export default {}\n')
    write(repo, 'packages/ts/tsconfig.json', '{}\n')
    write(repo, 'packages/ts/examples/http-server/server.ts', 'export const port = 7700\n')
    write(repo, 'packages/ts/examples/browser/app.ts', 'export const app = 1\n')
    write(repo, 'packages/ts/src/__tests__/index.test.ts', 'export const covered = 1\n')
    write(repo, 'benchmarks/in-process/src/run.ts', 'export const run = 1\n')
    git(repo, ['add', '.'])
    git(repo, ['commit', '-q', '-m', 'release'])
    git(repo, ['tag', TAG])
  })

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true })
  })

  it('matches the release tag on an untouched checkout', () => {
    const identity = readEngineSourceIdentity(repo)

    expect(identity.version).toBe(VERSION)
    expect(identity.releaseTag).toBe(TAG)
    expect(identity.matchesReleaseTag).toBe(true)
    expect(identity.changedPaths).toEqual([])
  })

  it('reports an engine source that differs, whether committed or not', () => {
    write(repo, 'packages/ts/src/index.ts', 'export const VERSION = 2\n')
    expect(readEngineSourceIdentity(repo).changedPaths).toEqual(['packages/ts/src/index.ts'])

    git(repo, ['commit', '-q', '-am', 'change the engine'])
    const committed = readEngineSourceIdentity(repo)
    expect(committed.matchesReleaseTag).toBe(false)
    expect(committed.changedPaths).toEqual(['packages/ts/src/index.ts'])
  })

  it('reports a changed build configuration and a changed server entry', () => {
    write(repo, 'packages/ts/tsup.config.ts', 'export default { minify: true }\n')
    write(repo, 'packages/ts/examples/http-server/server.ts', 'export const port = 8800\n')

    expect(readEngineSourceIdentity(repo).changedPaths).toEqual([
      'packages/ts/examples/http-server/server.ts',
      'packages/ts/tsup.config.ts',
    ])
  })

  it('ignores changes that cannot reach the engine', () => {
    write(repo, 'packages/ts/examples/browser/app.ts', 'export const app = 2\n')
    write(repo, 'packages/ts/src/__tests__/index.test.ts', 'export const covered = 2\n')
    write(repo, 'benchmarks/in-process/src/run.ts', 'export const run = 2\n')
    write(repo, 'packages/ts/src/untracked-draft.ts', 'export const draft = 1\n')

    expect(readEngineSourceIdentity(repo).matchesReleaseTag).toBe(true)
  })

  it('refuses a version that no tag published', () => {
    write(repo, 'packages/ts/package.json', '{"name":"@delali/narsil","version":"9.9.9"}\n')

    expect(codeOf(() => readEngineSourceIdentity(repo))).toBe('missing-release-tag')
  })

  it('refuses a checkout that declares no version', () => {
    write(repo, 'packages/ts/package.json', '{"name":"@delali/narsil"}\n')

    expect(codeOf(() => readEngineSourceIdentity(repo))).toBe('unreadable-engine-version')
  })
})

describe('assertPublishedEngineSource', () => {
  let repo: string

  beforeEach(() => {
    repo = mkdtempSync(join(os.tmpdir(), 'narsil-published-version-'))
    git(repo, ['init', '-q'])
    write(repo, 'packages/ts/package.json', `{"name":"@delali/narsil","version":"${VERSION}"}\n`)
    write(repo, 'packages/ts/src/index.ts', 'export const VERSION = 1\n')
    git(repo, ['add', '.'])
    git(repo, ['commit', '-q', '-m', 'release'])
    git(repo, ['tag', TAG])
  })

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true })
  })

  it('returns the identity when the sources match the tag', () => {
    expect(assertPublishedEngineSource(repo).version).toBe(VERSION)
  })

  it('refuses a source that differs and names every changed path', () => {
    write(repo, 'packages/ts/src/index.ts', 'export const VERSION = 2\n')

    expect(() => assertPublishedEngineSource(repo)).toThrow(/packages\/ts\/src\/index\.ts/)
    expect(codeOf(() => assertPublishedEngineSource(repo))).toBe('unpublished-engine-source')
  })
})

describe('outside a repository', () => {
  let plain: string

  beforeEach(() => {
    plain = mkdtempSync(join(os.tmpdir(), 'narsil-published-version-plain-'))
  })

  afterEach(() => {
    rmSync(plain, { recursive: true, force: true })
  })

  it('refuses to guess', () => {
    expect(codeOf(() => readEngineSourceIdentity(plain))).toBe('no-git-repository')
  })

  it('treats an impossible comparison as a difference', () => {
    expect(engineSourceDiffersFromRelease(plain)).toBe(true)
  })
})
