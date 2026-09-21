import { describe, expect, it } from 'vitest'
import { workerResourceLimits } from '../../workers/resource-limits'

describe('worker heap limits', () => {
  it('sets the young generation of a thread and leaves its old generation to the runtime', () => {
    expect(workerResourceLimits()).toEqual({ maxYoungGenerationSizeMb: 24 })
  })
})
