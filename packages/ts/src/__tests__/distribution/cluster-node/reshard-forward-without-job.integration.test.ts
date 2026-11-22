import { decode, encode } from '@msgpack/msgpack'
import { afterEach, describe, expect, it } from 'vitest'
import { createInMemoryTransport } from '../../../distribution/transport'
import { ClusterMessageTypes, type NodeTransport } from '../../../distribution/transport/types'
import { type SingleNodeCluster, startSingleNodeCluster, waitForActiveAllocation } from './cluster-harness'

const INDEX = 'ledger'

let cluster: SingleNodeCluster | null = null
let peer: NodeTransport | null = null

afterEach(async () => {
  await peer?.shutdown()
  peer = null
  await cluster?.shutdown()
  cluster = null
})

describe('a cluster.reshard_forward that no partition count change sends', () => {
  it('is refused with ALLOCATION_FAILED and writes nothing to the primary', async () => {
    const active = await startSingleNodeCluster()
    cluster = active
    await active.node.createIndex(INDEX, { schema: { title: 'string' } }, { partitionCount: 1, replicationFactor: 0 })
    await waitForActiveAllocation(active.coordinator, INDEX)
    await active.node.insert(INDEX, { title: 'opening balance' }, 'entry-1')

    peer = createInMemoryTransport('peer', active.network)
    const reply = await peer.send('node-a', {
      type: ClusterMessageTypes.RESHARD_FORWARD,
      sourceId: 'peer',
      requestId: 'forward-without-job',
      payload: encode({
        targetGeneration: INDEX,
        jobId: 'job-that-never-ran',
        sourcePartitionId: 0,
        sourcePrimaryTerm: 1,
        operations: [
          { documentId: 'entry-1', operation: 'replace', document: encode({ title: 'overwritten' }) },
          { documentId: 'entry-2', operation: 'replace', document: encode({ title: 'planted' }) },
        ],
      }),
    })

    const body = decode(reply.payload) as Record<string, unknown>
    expect(body.error).toBe(true)
    expect(body.code).toBe('ALLOCATION_FAILED')
    expect(await active.node.get(INDEX, 'entry-1')).toEqual({ title: 'opening balance' })
    expect(await active.node.get(INDEX, 'entry-2')).toBeUndefined()
    expect(await active.node.countDocuments(INDEX)).toBe(1)
  }, 60_000)
})
