import { existsSync, lstatSync, mkdtempSync, readFileSync, readlinkSync, rmSync, statSync } from 'node:fs'
import os from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { artifactFilename, prepareRunArtifact, prepareRunFolder } from '../run-paths'

describe('prepareRunFolder', () => {
  let tmpRoot: string

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(os.tmpdir(), 'narsil-bench-runs-'))
  })

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true })
  })

  it('creates a timestamped folder and META.txt inside runs/', () => {
    const now = new Date('2026-05-17T13:45:07.123Z')
    const result = prepareRunFolder({ packageRoot: tmpRoot, now })

    const expectedFolder = '2026-05-17T13-45-07-123Z'
    expect(result.timestamp).toBe(expectedFolder)
    expect(result.runDir).toBe(resolve(tmpRoot, 'runs', expectedFolder))
    expect(statSync(result.runDir).isDirectory()).toBe(true)

    const meta = readFileSync(result.metaPath, 'utf8')
    expect(meta).toMatch(/^date=2026-05-17T13:45:07\.123Z\n/)
    expect(meta).toMatch(/\nbranch=.+\n/)
    expect(meta).toMatch(/\ncommit=.+\n/)
    expect(meta).toMatch(/\ndirty=(true|false)\n/)
    expect(meta).toMatch(/\nnode=v\d/)
  })

  it('points latest symlink at the run folder via a relative target', () => {
    const now = new Date('2026-05-17T14:00:00.000Z')
    const result = prepareRunFolder({ packageRoot: tmpRoot, now })

    expect(lstatSync(result.latestSymlink).isSymbolicLink()).toBe(true)
    expect(readlinkSync(result.latestSymlink)).toBe(result.timestamp)

    const followed = resolve(result.latestSymlink, '..', readlinkSync(result.latestSymlink))
    expect(followed).toBe(result.runDir)
  })

  it('replaces latest on the second invocation without removing prior runs', () => {
    const first = prepareRunFolder({
      packageRoot: tmpRoot,
      now: new Date('2026-05-17T12:00:00.000Z'),
    })
    const second = prepareRunFolder({
      packageRoot: tmpRoot,
      now: new Date('2026-05-17T13:00:00.000Z'),
    })

    expect(existsSync(first.runDir)).toBe(true)
    expect(existsSync(second.runDir)).toBe(true)
    expect(first.runDir).not.toBe(second.runDir)
    expect(readlinkSync(first.latestSymlink)).toBe(second.timestamp)
  })

  it('replaces a pre-existing latest symlink that pointed at a stale target', () => {
    const stale = prepareRunFolder({
      packageRoot: tmpRoot,
      now: new Date('2026-05-17T10:00:00.000Z'),
    })
    rmSync(stale.runDir, { recursive: true, force: true })

    const fresh = prepareRunFolder({
      packageRoot: tmpRoot,
      now: new Date('2026-05-17T11:00:00.000Z'),
    })

    expect(readlinkSync(fresh.latestSymlink)).toBe(fresh.timestamp)
  })

  it('throws when given an invalid Date', () => {
    const bad = new Date('not-a-date')
    expect(() => prepareRunFolder({ packageRoot: tmpRoot, now: bad })).toThrow(TypeError)
  })
})

describe('prepareRunArtifact', () => {
  let tmpRoot: string

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(os.tmpdir(), 'narsil-bench-runs-'))
  })

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true })
  })

  it('returns an artifact path inside the run folder for each known artifact', () => {
    const now = new Date('2026-05-17T15:00:00.000Z')
    const expectedFolder = '2026-05-17T15-00-00-000Z'

    const comparative = prepareRunArtifact('comparative', { packageRoot: tmpRoot, now })
    expect(comparative.artifactPath).toBe(resolve(tmpRoot, 'runs', expectedFolder, 'results.json'))

    const synthetic = prepareRunArtifact('synthetic', { packageRoot: tmpRoot, now })
    expect(synthetic.artifactPath).toBe(resolve(tmpRoot, 'runs', expectedFolder, 'synthetic-results.json'))

    const scenarios = prepareRunArtifact('scenarios', { packageRoot: tmpRoot, now })
    expect(scenarios.artifactPath).toBe(resolve(tmpRoot, 'runs', expectedFolder, 'scenario-results.json'))

    const memory = prepareRunArtifact('memoryProfile', { packageRoot: tmpRoot, now })
    expect(memory.artifactPath).toBe(resolve(tmpRoot, 'runs', expectedFolder, 'memory-profile.json'))
  })

  it('exposes the filename mapping for explicit consumers like heap snapshots', () => {
    expect(artifactFilename('heapSnapshot')).toBe('heap.heapsnapshot')
    expect(artifactFilename('comparative')).toBe('results.json')
  })
})
