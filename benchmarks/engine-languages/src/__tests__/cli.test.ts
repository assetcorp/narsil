import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { MAX_REPETITIONS, MAX_THREADS } from '../constants'
import { SUITE_ROOT } from '../paths'

function invoke(args: string[], profile = 'smoke') {
  const result = spawnSync(
    process.execPath,
    [
      '--import',
      'tsx',
      resolve(SUITE_ROOT, 'src/run.ts'),
      ...args,
      '--workload',
      resolve(SUITE_ROOT, '.absent-test-workload'),
    ],
    {
      cwd: SUITE_ROOT,
      encoding: 'utf-8',
      timeout: 5000,
      env: { ...process.env, BENCH_PROFILE: profile },
    },
  )
  return { status: result.status, output: `${result.stdout}\n${result.stderr}` }
}

describe('the benchmark command line', () => {
  it.each([
    ['--threads', '0'],
    ['--threads', '-1'],
    ['--threads', '1.5'],
    ['--threads', '1e1'],
    ['--threads', String(MAX_THREADS + 1)],
    ['--threads', '9007199254740992'],
    ['--threads', '1,01'],
    ['--threads', '1,1'],
    ['--threads', '1,'],
    ['--threads', ''],
    ['--repetitions', '0'],
    ['--repetitions', String(MAX_REPETITIONS + 1)],
    ['--repetitions', 'NaN'],
    ['--size', 'medium'],
    ['--engines', 'python'],
    ['--engines', 'go,go'],
    ['--engines', ''],
    ['--output-root', ''],
    ['--output-root', ' '],
    ['--unknown', '1'],
  ])('refuses %s %j before reading a workload', (flag, value) => {
    const result = invoke([flag, value])
    expect(result.status).toBe(1)
    expect(result.output).not.toContain('ENOENT')
    expect(result.output).not.toContain('Building the')
  })

  it.each([
    ['--threads', '1'],
    ['--threads', String(MAX_THREADS)],
    ['--repetitions', '1'],
    ['--repetitions', String(MAX_REPETITIONS)],
  ])('accepts the boundary %s %s', (flag, value) => {
    expect(invoke([flag, value]).output).toContain('ENOENT')
  })

  it('refuses an unknown profile', () => {
    expect(invoke([], 'invalid').output).toContain('invalid benchmark profile')
  })
})
