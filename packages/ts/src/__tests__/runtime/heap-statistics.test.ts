import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readHeapStatistics } from '../../runtime/heap-statistics'

const MEGABYTE_BYTES = 1_048_576

describe('the heap limit an operator sets', () => {
  let nodeOptions: string | undefined
  let execArgv: string[]

  beforeEach(() => {
    nodeOptions = process.env.NODE_OPTIONS
    execArgv = process.execArgv
    delete process.env.NODE_OPTIONS
    process.execArgv = []
  })

  afterEach(() => {
    if (nodeOptions === undefined) delete process.env.NODE_OPTIONS
    else process.env.NODE_OPTIONS = nodeOptions
    process.execArgv = execArgv
  })

  it('reads the megabytes that the command line names', () => {
    process.execArgv = ['--max-old-space-size=256']

    expect(readHeapStatistics()?.configuredLimitBytes).toBe(256 * MEGABYTE_BYTES)
  })

  it('reads the megabytes that NODE_OPTIONS names, because the command line holds none', () => {
    process.env.NODE_OPTIONS = '--max-old-space-size=512 --enable-source-maps'

    expect(readHeapStatistics()?.configuredLimitBytes).toBe(512 * MEGABYTE_BYTES)
  })

  it('takes a share of the host memory for the percentage flag', () => {
    process.execArgv = ['--max-old-space-size-percentage=25']
    const configured = readHeapStatistics()?.configuredLimitBytes

    expect(configured).not.toBeNull()
    expect(configured).toBeGreaterThan(0)
  })

  it('takes the last flag where a process carries both forms', () => {
    process.execArgv = ['--max-old-space-size-percentage=25', '--max-old-space-size=128']

    expect(readHeapStatistics()?.configuredLimitBytes).toBe(128 * MEGABYTE_BYTES)
  })

  it('reports no configured limit where the process names none', () => {
    expect(readHeapStatistics()?.configuredLimitBytes).toBeNull()
  })
})
