import { afterEach, describe, expect, it, vi } from 'vitest'
import { resolveRunnableConfig } from '../../engine/startup-checks'
import { createNarsil } from '../../narsil'
import { missingWorkerEntry } from '../../workers/entry-point'

const workerEntry = vi.hoisted(() => ({ missing: false }))

vi.mock('#platform/worker-factory', async importOriginal => {
  const actual = await importOriginal<typeof import('../../workers/factory')>()
  return {
    ...actual,
    requireWorkerEntry: async () => {
      if (workerEntry.missing) throw missingWorkerEntry('file:///app/server.mjs')
      return actual.requireWorkerEntry()
    },
  }
})

describe('the worker entry an engine checks as it starts', () => {
  afterEach(() => {
    workerEntry.missing = false
    vi.restoreAllMocks()
  })

  it('answers on one thread and says why once where default settings find no worker entry', async () => {
    workerEntry.missing = true
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    const first = await resolveRunnableConfig({ workers: { count: 4 } })
    const second = await resolveRunnableConfig(undefined)

    expect(first?.workers).toEqual({ count: 4, enabled: false })
    expect(second?.workers?.enabled).toBe(false)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0]?.[0])).toContain('file:///app/server.mjs')
  })

  it('refuses to start where the configuration asks for workers and no worker entry exists', async () => {
    workerEntry.missing = true

    await expect(createNarsil({ workers: { enabled: true } })).rejects.toMatchObject({ code: 'CONFIG_INVALID' })
  })

  it('leaves the configuration alone where workers are off', async () => {
    workerEntry.missing = true
    const config = { workers: { enabled: false } }

    expect(await resolveRunnableConfig(config)).toBe(config)
  })
})

describe('the search backend settings an engine checks as it starts', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('refuses to start where NARSIL_REQUIRE_NATIVE_CORE is 1 and no core loads', async () => {
    vi.stubEnv('NARSIL_REQUIRE_NATIVE_CORE', '1')
    vi.stubEnv('NARSIL_NATIVE_CORE_PATH', '/nonexistent/narsil-core.node')

    await expect(createNarsil({ workers: { enabled: false } })).rejects.toMatchObject({ code: 'CONFIG_INVALID' })
  })

  it('refuses to start where NARSIL_SEARCH_BACKEND names no backend', async () => {
    vi.stubEnv('NARSIL_SEARCH_BACKEND', 'gpu')

    await expect(createNarsil({ workers: { enabled: false } })).rejects.toMatchObject({ code: 'CONFIG_INVALID' })
  })
})
