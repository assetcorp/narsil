import { decode } from '@msgpack/msgpack'
import { expect, it } from 'vitest'
import { createNarsilClient } from '../../../client'
import { createClusterNode } from '../../../distribution/cluster-node'
import { clusterNodeEngine } from '../../../distribution/cluster-node/server-engine'
import type { ClusterNode } from '../../../distribution/cluster-node/types'
import { createInMemoryCoordinator } from '../../../distribution/coordinator'
import { createInMemoryNetwork, createInMemoryTransport } from '../../../distribution/transport'
import type { NodeTransport, SearchResultPayload } from '../../../distribution/transport/types'
import { createServer, type NarsilServer } from '../../../server'
import { expectedFusion, fusionDocuments, fusionIndex, fusionQuery } from '../../integration/hybrid-fusion-fixtures'
import { waitForActiveAllocation } from './cluster-harness'

it('preserves non-finite scores across cluster messages before fusion and raw group assembly', async () => {
  const coordinator = createInMemoryCoordinator()
  const network = createInMemoryNetwork()
  const nodes: ClusterNode[] = []
  const transports: NodeTransport[] = []
  const legScores: number[] = []
  const respondingNodes = new Set<string>()
  let server: NarsilServer | undefined
  try {
    for (const nodeId of ['data-a', 'data-b', 'data-c']) {
      const transport = createInMemoryTransport(nodeId, network)
      transports.push(transport)
      const node = await createClusterNode({
        coordinator,
        transport,
        address: `${nodeId}:9200`,
        nodeId,
        roles: ['data'],
      })
      nodes.push(node)
      await node.start()
    }
    const transport = createInMemoryTransport('router', network)
    transports.push(transport)
    const observed: NodeTransport = {
      ...transport,
      async send(target, message) {
        const reply = await transport.send(target, message)
        if (reply.type === 'query.search_result') {
          const payload = decode(reply.payload) as SearchResultPayload
          for (const partition of payload.results) {
            if (partition.scored.length > 0) respondingNodes.add(target)
            for (const entry of partition.scored) if (typeof entry.score === 'number') legScores.push(entry.score)
          }
        }
        return reply
      },
    }
    const router = await createClusterNode({
      coordinator,
      transport: observed,
      address: 'router:9200',
      nodeId: 'router',
      roles: ['controller', 'coordinator'],
      query: { allowPartialResults: false },
    })
    nodes.push(router)
    await router.start()
    await router.createIndex('products', fusionIndex, { partitionCount: 8, replicationFactor: 0 })
    await waitForActiveAllocation(coordinator, 'products')
    expect((await router.insertBatch('products', fusionDocuments)).failed).toEqual([])
    server = createServer(clusterNodeEngine(router), { host: '127.0.0.1', port: 0, cluster: router.cluster })
    await server.listen()
    const client = createNarsilClient({ url: `http://127.0.0.1:${server.listeningPort}` })
    const answer = await client.query('products', {
      ...fusionQuery(Number.MAX_VALUE, 0.5),
      group: { fields: ['kind'], maxPerGroup: 1 },
    })
    expect(answer.hits.map(({ id, score }) => ({ id, score }))).toEqual(expectedFusion(0.5, true))
    expect(answer.groups?.flatMap(group => group.hits.map(({ id, score }) => ({ id, score })))).toEqual([
      { id: 'positive', score: Infinity },
      { id: 'zero', score: 0 },
      { id: 'negative', score: -Infinity },
      { id: 'cancelled', score: Number.NaN },
    ])
    expect(legScores).toContain(Infinity)
    expect(legScores).toContain(-Infinity)
    expect(legScores.some(Number.isNaN)).toBe(true)
    expect(respondingNodes.size).toBeGreaterThan(1)
  } finally {
    await server?.close()
    for (const node of nodes.toReversed()) await node.shutdown()
    for (const transport of transports) await transport.shutdown()
    await coordinator.shutdown()
  }
})
