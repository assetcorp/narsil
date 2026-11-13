import { resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { type BenchProfile, resolveProfile } from 'benchmarks/src/runner/run-paths'
import { MAX_REPETITIONS, MAX_THREADS, REPETITIONS, SMALL_REPETITIONS, THREAD_COUNTS } from './constants'
import { ENGINE_NAMES, type EngineName } from './runner-output'
import type { WorkloadSize } from './workload/settings'

export interface RunOptions {
  size: WorkloadSize
  workload: string | null
  engines: EngineName[]
  threadCounts: number[]
  repetitions: number
  profile: BenchProfile
  outputRoot: string | null
  keepOutputs: boolean
}

const USAGE = [
  'usage: pnpm bench [--size full|small] [--workload <directory>] [--engines typescript,rust,go]',
  '                  [--threads 1,8] [--repetitions <count>] [--output-root <directory>] [--keep-outputs]',
].join('\n')

function isEngineName(value: string): value is EngineName {
  return (ENGINE_NAMES as readonly string[]).includes(value)
}

function listOf(raw: string, what: string): string[] {
  const items = raw.split(',').map(item => item.trim())
  if (items.some(item => item.length === 0)) throw new Error(`--${what} takes a comma-separated list\n${USAGE}`)
  if (new Set(items).size !== items.length) throw new Error(`--${what} lists an entry twice\n${USAGE}`)
  return items
}

function wholeNumberIn(raw: string, what: string, max: number): number {
  const value = Number(raw)
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(value) || value < 1 || value > max) {
    throw new Error(`--${what} takes a whole number from 1 to ${max}, not ${JSON.stringify(raw)}\n${USAGE}`)
  }
  return value
}

export function parseRunOptions(argv: readonly string[]): RunOptions {
  const { values } = parseArgs({
    args: [...argv],
    strict: true,
    allowPositionals: false,
    options: {
      size: { type: 'string', default: 'full' },
      workload: { type: 'string' },
      engines: { type: 'string', default: ENGINE_NAMES.join(',') },
      threads: { type: 'string', default: THREAD_COUNTS.join(',') },
      repetitions: { type: 'string' },
      'output-root': { type: 'string' },
      'keep-outputs': { type: 'boolean', default: false },
    },
  })
  if (values.size !== 'full' && values.size !== 'small') {
    throw new Error(`--size takes full or small, not ${JSON.stringify(values.size)}\n${USAGE}`)
  }
  const engines = listOf(values.engines, 'engines').map(name => {
    if (!isEngineName(name)) throw new Error(`--engines takes ${ENGINE_NAMES.join(', ')}, not ${name}\n${USAGE}`)
    return name
  })
  const threadCounts = listOf(values.threads, 'threads').map(raw => wholeNumberIn(raw, 'threads', MAX_THREADS))
  if (new Set(threadCounts).size !== threadCounts.length) throw new Error('--threads lists a count twice')
  for (const key of ['workload', 'output-root'] as const) {
    if (values[key] !== undefined && values[key].trim().length === 0) throw new Error(`--${key} needs a path`)
  }
  const defaultRepetitions = values.size === 'small' ? SMALL_REPETITIONS : REPETITIONS
  return {
    size: values.size,
    workload: values.workload === undefined ? null : resolve(values.workload),
    engines,
    threadCounts,
    repetitions:
      values.repetitions === undefined
        ? defaultRepetitions
        : wholeNumberIn(values.repetitions, 'repetitions', MAX_REPETITIONS),
    profile: resolveProfile(),
    outputRoot: values['output-root'] === undefined ? null : resolve(values['output-root']),
    keepOutputs: values['keep-outputs'],
  }
}
