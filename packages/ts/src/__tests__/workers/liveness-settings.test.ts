import { describe, expect, it } from 'vitest'
import { createNarsil } from '../../narsil'
import type { NarsilConfig, WorkerConfig } from '../../types/config'

const REJECTED_SETTINGS: Array<[string, Partial<WorkerConfig>]> = [
  ['a probe silence of zero', { silenceBeforeProbeMs: 0 }],
  ['a fractional probe silence', { silenceBeforeProbeMs: 1.5 }],
  ['a negative retirement silence', { silenceBeforeRetirementMs: -1 }],
  ['a retirement silence beyond a safe integer', { silenceBeforeRetirementMs: Number.MAX_SAFE_INTEGER + 2 }],
  [
    'a probe silence equal to the retirement silence',
    { silenceBeforeProbeMs: 5_000, silenceBeforeRetirementMs: 5_000 },
  ],
  ['a probe silence past the default retirement silence', { silenceBeforeProbeMs: 90_001 }],
  ['a retirement silence below the default probe silence', { silenceBeforeRetirementMs: 9_999 }],
  ['a negative cap on threads left running', { maxThreadsLeftRunning: -1 }],
  ['a fractional cap on threads left running', { maxThreadsLeftRunning: 0.5 }],
  ['a text cap on threads left running', { maxThreadsLeftRunning: '2' as unknown as number }],
]

const ACCEPTED_SETTINGS: Array<[string, Partial<WorkerConfig>]> = [
  ['a short probe and retirement', { silenceBeforeProbeMs: 1, silenceBeforeRetirementMs: 2 }],
  ['a cap of zero threads left running', { maxThreadsLeftRunning: 0 }],
]

describe('worker liveness settings', () => {
  for (const enabled of [false, true]) {
    describe(enabled ? 'with workers enabled' : 'with workers disabled', () => {
      it.each(REJECTED_SETTINGS)('rejects %s', async (_label, settings) => {
        await expect(createNarsil({ workers: { enabled, ...settings } } as NarsilConfig)).rejects.toMatchObject({
          code: 'CONFIG_INVALID',
        })
      })

      it.each(ACCEPTED_SETTINGS)('accepts %s', async (_label, settings) => {
        const narsil = await createNarsil({ workers: { enabled, ...settings } })
        await narsil.shutdown()
      })
    })
  }
})
