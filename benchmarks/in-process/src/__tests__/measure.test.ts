import { describe, expect, it } from 'vitest'
import { measureMemory } from '../measure'

const OFF_HEAP_BYTES = 64 * 1024 * 1024
const HEAP_DRIFT_ALLOWANCE = 0.9

describe('measureMemory', () => {
  it('counts memory an engine has allocated outside the JavaScript heap', async () => {
    let backing: ArrayBuffer | null = null
    const engine = {
      async create() {},
      async insert(_documents: number[]) {
        backing = new ArrayBuffer(OFF_HEAP_BYTES)
        new Uint8Array(backing).fill(1)
      },
      async teardown() {
        backing = null
      },
    }

    const bytes = await measureMemory(engine, [1])

    expect(bytes).toBeGreaterThanOrEqual(OFF_HEAP_BYTES * HEAP_DRIFT_ALLOWANCE)
  })
})
