import { encode } from '@msgpack/msgpack'
import { describe, expect, it, vi } from 'vitest'
import { fetchSnapshotFromAnyTarget, jitteredBackoff } from '../../../distribution/cluster-node/bootstrap-fetch'
import type { NodeTransport } from '../../../distribution/transport/types'
import { ErrorCodes } from '../../../errors'

function errorChunk(code: string): Uint8Array {
  return encode({ error: true, code, message: 'simulated' })
}

describe('bootstrap-fetch pass-4 findings', () => {
  it('M-E: protocol DECODE_FAILED errors retry across targets but not beyond the target count', async () => {
    const streamFn = vi.fn().mockImplementation(async (_target, _message, handler) => {
      // Malformed msgpack: 0xc1 is an unused tag that triggers DECODE_FAILED.
      handler(new Uint8Array([0xc1, 0xc1, 0xc1]))
    })
    const transport: NodeTransport = {
      send: async () => {
        throw new Error('send not used')
      },
      stream: streamFn,
      listen: async () => () => {},
      shutdown: async () => {},
    }
    const targets = ['target-a', 'target-b']
    const deadline = Date.now() + 10_000
    const result = await fetchSnapshotFromAnyTarget(
      'products',
      'primary',
      targets,
      deadline,
      { transport, sourceNodeId: 'replica' },
      () => false,
    )
    expect(result.ok).toBe(false)
    // Protocol budget equals target count; exactly one call per distinct target.
    expect(streamFn).toHaveBeenCalledTimes(targets.length)
  })

  it('M-E: protocol errors do NOT cycle indefinitely on a single target even if there are many retries available', async () => {
    // The attempted set already prevents same-target retries. This test verifies
    // that combined with the protocol-budget cap, the total call count never
    // exceeds the number of DISTINCT targets.
    const streamFn = vi.fn().mockImplementation(async (_target, _message, handler) => {
      handler(new Uint8Array([0xc1, 0xc1, 0xc1]))
    })
    const transport: NodeTransport = {
      send: async () => {
        throw new Error('send not used')
      },
      stream: streamFn,
      listen: async () => () => {},
      shutdown: async () => {},
    }
    // Duplicate targets are deduplicated by the attempted set.
    const targets = ['t1', 't2', 't1', 't2', 't1']
    await fetchSnapshotFromAnyTarget(
      'products',
      'primary',
      targets,
      Date.now() + 10_000,
      { transport, sourceNodeId: 'replica' },
      () => false,
    )
    expect(streamFn).toHaveBeenCalledTimes(2)
  })

  it('M-E: non-transient failures still short-circuit on the first failing target', async () => {
    const streamFn = vi.fn().mockImplementation(async (_target, _message, handler) => {
      handler(errorChunk(ErrorCodes.SNAPSHOT_SYNC_UNAUTHORIZED))
    })
    const transport: NodeTransport = {
      send: async () => {
        throw new Error('send not used')
      },
      stream: streamFn,
      listen: async () => () => {},
      shutdown: async () => {},
    }
    const result = await fetchSnapshotFromAnyTarget(
      'products',
      'primary',
      ['target-a', 'target-b'],
      Date.now() + 10_000,
      { transport, sourceNodeId: 'replica' },
      () => false,
    )
    expect(result.ok).toBe(false)
    expect(streamFn).toHaveBeenCalledTimes(1)
  })

  it('L-F: jitteredBackoff returns within the deadline, not after the jitter window', async () => {
    const start = Date.now()
    const deadline = start + 25
    const aborted = await jitteredBackoff(100, 500, deadline, () => false)
    const elapsed = Date.now() - start
    expect(aborted).toBe(false)
    expect(elapsed).toBeLessThan(60)
  })

  it('L-F: jitteredBackoff returns promptly when abort fires', async () => {
    const deadline = Date.now() + 10_000
    let aborted = false
    const sleep = jitteredBackoff(100, 500, deadline, () => aborted)
    setTimeout(() => {
      aborted = true
    }, 10)
    const start = Date.now()
    const result = await sleep
    const elapsed = Date.now() - start
    expect(result).toBe(true)
    expect(elapsed).toBeLessThan(150)
  })

  it('L-F: jitteredBackoff returns false immediately when the deadline is already past', async () => {
    const deadline = Date.now() - 10
    const start = Date.now()
    const result = await jitteredBackoff(100, 500, deadline, () => false)
    const elapsed = Date.now() - start
    expect(result).toBe(false)
    expect(elapsed).toBeLessThan(15)
  })
})
