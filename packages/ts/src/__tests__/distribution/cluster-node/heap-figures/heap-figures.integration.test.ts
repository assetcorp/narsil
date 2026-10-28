import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const REPORT_NODE = fileURLToPath(new URL('./report-node.mjs', import.meta.url))
const MEBIBYTE = 1_048_576
const OLD_SPACE_MEGABYTES = 160
const LARGEST_YOUNG_SHARE_OF_OLD_SPACE_V8_PICKS = 3 / 64
const CHILD_TIMEOUT_MS = 60_000

interface ReportedMemory {
  memory: { heapLimitBytes: number } | null
  heapSizeLimitBytes: number
}

function childEnvironment(nodeOptions: string): NodeJS.ProcessEnv {
  return { ...process.env, NODE_OPTIONS: nodeOptions }
}

function heapSizeLimitUnder(flags: string[]): number {
  const finished = spawnSync(
    process.execPath,
    [...flags, '-e', 'process.stdout.write(String(require("node:v8").getHeapStatistics().heap_size_limit))'],
    { encoding: 'utf8', env: childEnvironment(''), timeout: CHILD_TIMEOUT_MS },
  )
  expect(finished.status, finished.stderr).toBe(0)
  return Number(finished.stdout)
}

function youngShareUnder(flags: string[]): number {
  return heapSizeLimitUnder([...flags, `--max-old-space-size=${OLD_SPACE_MEGABYTES}`]) - OLD_SPACE_MEGABYTES * MEBIBYTE
}

function reportUnder(flags: string[], nodeOptions = ''): ReportedMemory {
  const finished = spawnSync(process.execPath, [...flags, REPORT_NODE], {
    encoding: 'utf8',
    env: childEnvironment(nodeOptions),
    timeout: CHILD_TIMEOUT_MS,
  })
  expect(finished.status, finished.stderr).toBe(0)
  const line = finished.stdout.split('\n').find(entry => entry.startsWith('{'))
  if (line === undefined) throw new Error(`the node printed no memory report: ${finished.stdout}${finished.stderr}`)
  const reported = JSON.parse(line) as ReportedMemory
  expect(reported.memory, 'the node registered no memory figures').not.toBeNull()
  return reported
}

function limitOf(reported: ReportedMemory): number {
  if (reported.memory === null) throw new Error('the node registered no memory figures')
  return reported.memory.heapLimitBytes
}

describe('the heap figures a cluster node registers leave the young generation out of both sides', () => {
  it('takes the old-space flag as the limit, from the command line or from NODE_OPTIONS', () => {
    const fromCommandLine = reportUnder([`--max-old-space-size=${OLD_SPACE_MEGABYTES}`])
    const fromNodeOptions = reportUnder([], `--max-old-space-size=${OLD_SPACE_MEGABYTES * 2}`)

    expect(limitOf(fromCommandLine)).toBe(OLD_SPACE_MEGABYTES * MEBIBYTE)
    expect(limitOf(fromNodeOptions)).toBe(OLD_SPACE_MEGABYTES * 2 * MEBIBYTE)
    expect(fromCommandLine.heapSizeLimitBytes).toBeGreaterThan(limitOf(fromCommandLine))
  })

  it('subtracts the young generation that a semi-space flag reserves once V8 rounds it up to a power of two', () => {
    const semiSpaceFlag = '--max-semi-space-size=5'
    const reported = reportUnder([semiSpaceFlag])

    expect(limitOf(reported)).toBe(reported.heapSizeLimitBytes - youngShareUnder([semiSpaceFlag]))
  })

  it('keeps the limit within the young share that V8 picks itself under no heap flag', () => {
    const reported = reportUnder([])
    const oldSpaceBytes = reported.heapSizeLimitBytes - youngShareUnder([])

    expect(limitOf(reported)).toBeLessThan(reported.heapSizeLimitBytes)
    expect(limitOf(reported)).toBeGreaterThanOrEqual(oldSpaceBytes)
    expect(limitOf(reported)).toBeLessThanOrEqual(oldSpaceBytes * (1 + LARGEST_YOUNG_SHARE_OF_OLD_SPACE_V8_PICKS))
  })
})
