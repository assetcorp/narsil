import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const MEGABYTE_BYTES = 1_048_576

async function configuredLimitUnder(flags: { execArgv?: string[]; nodeOptions?: string }): Promise<number | null> {
  const realExecArgv = process.execArgv
  const realNodeOptions = process.env.NODE_OPTIONS
  process.execArgv = flags.execArgv ?? []
  if (flags.nodeOptions === undefined) delete process.env.NODE_OPTIONS
  else process.env.NODE_OPTIONS = flags.nodeOptions
  try {
    const { readHeapStatistics } = await import('../../runtime/heap-statistics')
    return readHeapStatistics()?.configuredLimitBytes ?? null
  } finally {
    process.execArgv = realExecArgv
    if (realNodeOptions === undefined) delete process.env.NODE_OPTIONS
    else process.env.NODE_OPTIONS = realNodeOptions
  }
}

describe('the heap limit an operator sets', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  afterEach(() => {
    vi.resetModules()
  })

  it('reads the megabytes that the command line names', async () => {
    await expect(configuredLimitUnder({ execArgv: ['--max-old-space-size=256'] })).resolves.toBe(256 * MEGABYTE_BYTES)
  })

  it('reads the megabytes that NODE_OPTIONS names, because the command line holds none', async () => {
    const configured = await configuredLimitUnder({ nodeOptions: '--max-old-space-size=512 --enable-source-maps' })

    expect(configured).toBe(512 * MEGABYTE_BYTES)
  })

  it('takes a share of the host memory for the percentage flag', async () => {
    const configured = await configuredLimitUnder({ execArgv: ['--max-old-space-size-percentage=25'] })

    expect(configured).toBeGreaterThan(0)
  })

  it('takes the last flag where a process carries both forms', async () => {
    const configured = await configuredLimitUnder({
      execArgv: ['--max-old-space-size-percentage=25', '--max-old-space-size=128'],
    })

    expect(configured).toBe(128 * MEGABYTE_BYTES)
  })

  it('reports no configured limit where the process names none', async () => {
    await expect(configuredLimitUnder({ execArgv: ['--experimental-strip-types'] })).resolves.toBeNull()
  })
})
