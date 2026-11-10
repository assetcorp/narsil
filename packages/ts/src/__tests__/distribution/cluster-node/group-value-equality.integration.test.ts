import { isDeepStrictEqual } from 'node:util'
import { decode } from '@msgpack/msgpack'
import { expect, it } from 'vitest'
import { createClusterNode } from '../../../distribution/cluster-node'
import type { ClusterNode } from '../../../distribution/cluster-node/types'
import { createInMemoryCoordinator } from '../../../distribution/coordinator'
import { createInMemoryNetwork, createInMemoryTransport } from '../../../distribution/transport'
import type { NodeTransport, SearchResultPayload } from '../../../distribution/transport/types'
import type { AnyDocument } from '../../../types/schema'
import { waitForActiveAllocation } from './cluster-harness'

it('keeps distinct stored values in separate groups across nodes and folds every member before truncation', async () => {
  const examples: unknown[][] = [
    [undefined, null, undefined, null],
    [Number.NaN, Number.NaN, Number.NaN, Number.NaN],
    [Infinity, Infinity, Infinity, Infinity],
    [-Infinity, -Infinity, -Infinity, -Infinity],
    [-0, 0, -0, 0],
    [1, 1, 1, 1],
    [[], [], [], []],
    [[null], [null], [null], [null]],
    [[Number.NaN], [Number.NaN], [Number.NaN], [Number.NaN]],
    [[Infinity], [Infinity], [Infinity], [Infinity]],
    [[-Infinity], [-Infinity], [-Infinity], [-Infinity]],
    [[-0], [0], [-0], [0]],
    [[1], [1], [1], [1]],
    [{ value: Number.NaN }, { value: Number.NaN }, { value: Number.NaN }, { value: Number.NaN }],
    [{ value: null }, { value: null }, { value: null }, { value: null }],
    ['NaN', 'NaN', 'NaN', 'NaN'],
    Array.from({ length: 4 }, () => `\ufeff${'x'.repeat(197)}`),
    Array.from({ length: 4 }, () => `\ufeff${'x'.repeat(198)}`),
    Array.from({ length: 4 }, () => 'x'.repeat(198)),
    Array.from({ length: 4 }, () => ({ [`\ufeff${'key'.repeat(80)}`]: [`\ufeff${'x'.repeat(198)}`] })),
  ]
  const documents = examples.flatMap((values, group) =>
    values.map((value, member) => ({
      id: `group-${String(group).padStart(2, '0')}-${member}`,
      title: 'catalogue',
      label: `${group}:${member}`,
      ...(value === undefined ? {} : { value }),
    })),
  )
  const coordinator = createInMemoryCoordinator()
  const network = createInMemoryNetwork()
  const nodes: ClusterNode[] = []
  const transports: NodeTransport[] = []
  const respondingNodes = new Set<string>()
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
          if (payload.groups?.some(group => group.scored.length > 0)) respondingNodes.add(target)
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
    const config = { schema: { title: 'string', label: 'string' } } as const
    await router.createIndex('catalogue', config, { partitionCount: 8, replicationFactor: 0 })
    await waitForActiveAllocation(coordinator, 'catalogue')
    expect((await router.insertBatch('catalogue', documents.toReversed())).failed).toEqual([])
    const answer = await router.query('catalogue', {
      term: 'catalogue',
      fields: ['title'],
      scoring: 'dfs',
      document: false,
      group: {
        fields: ['value'],
        maxPerGroup: 1,
        reduce: {
          initialValue: () => [],
          reducer: (members: unknown, member: AnyDocument) =>
            Array.isArray(members) ? [...members, member.label] : [],
        },
      },
    })
    expect(answer.groups).toHaveLength(examples.length)
    for (let group = 0; group < examples.length; group++) {
      const found = answer.groups?.[group]
      const expected = documents.slice(group * 4, group * 4 + 4)
      expect(found?.hits.map(hit => hit.id)).toEqual([expected[0].id])
      expect(examples[group].some(value => isDeepStrictEqual(value, found?.values.value))).toBe(true)
      expect(found?.reduced).toEqual(expected.map(row => row.label))
    }
    expect(respondingNodes.size).toBeGreaterThan(1)
  } finally {
    for (const node of nodes.toReversed()) await node.shutdown()
    for (const transport of transports) await transport.shutdown()
    await coordinator.shutdown()
  }
}, 30_000)
