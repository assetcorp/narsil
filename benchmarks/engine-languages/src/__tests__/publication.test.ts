import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, resolve } from 'node:path'
import { latestRunId } from 'benchmarks/src/runner/run-paths'
import { afterAll, expect, it } from 'vitest'
import { publishRun } from '../publication'

const root = mkdtempSync(resolve(tmpdir(), 'narsil-publication-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))

it('publishes complete folders without overwriting another repetition finished in the same second', () => {
  const options = { packageRoot: root, profile: 'smoke' as const, now: new Date('2026-01-01T00:00:00.100Z') }
  const runs = resolve(root, 'results', '.smoke', 'runs')
  expect(() =>
    publishRun(options, prepared => {
      writeFileSync(resolve(prepared.runDir, 'results.json'), '{')
      expect(readdirSync(runs).filter(name => !name.startsWith('.'))).toEqual([])
      throw new Error('interrupted publication')
    }),
  ).toThrow('interrupted publication')
  expect(readdirSync(runs)).toEqual([])
  const first = publishRun(options, prepared =>
    writeFileSync(resolve(prepared.runDir, 'results.json'), '{"first":true}'),
  )
  const second = publishRun({ ...options, now: new Date('2026-01-01T00:00:00.900Z') }, prepared =>
    writeFileSync(resolve(prepared.runDir, 'results.json'), '{"second":true}'),
  )
  expect(first).not.toBe(second)
  expect(readFileSync(resolve(first, 'results.json'), 'utf-8')).toBe('{"first":true}')
  expect(existsSync(resolve(second, 'run.json'))).toBe(true)
  expect(readdirSync(runs)).toHaveLength(2)
  expect(latestRunId(root, 'smoke')).toBe(basename(second))
})
