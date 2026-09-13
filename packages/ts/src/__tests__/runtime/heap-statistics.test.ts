import { totalmem } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { readHostMemoryBytes } from '../../runtime/heap-statistics'

const UNCONSTRAINED_BYTES = 2 ** 64

describe('the memory a host allows', () => {
  const reported = process.constrainedMemory

  afterEach(() => {
    process.constrainedMemory = reported
  })

  it('answers with a limit below the machine memory and with nothing above it', () => {
    const quarter = Math.floor(totalmem() / 4)
    process.constrainedMemory = () => quarter
    expect(readHostMemoryBytes()).toBe(quarter)

    process.constrainedMemory = () => UNCONSTRAINED_BYTES
    expect(readHostMemoryBytes()).toBeNull()
  })
})
