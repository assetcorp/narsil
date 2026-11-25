import { expect, it } from 'vitest'
import { createClusterNode } from '../../../distribution/cluster-node'
import { createInMemoryCoordinator } from '../../../distribution/coordinator'
import { createInMemoryNetwork, createInMemoryTransport } from '../../../distribution/transport'

it('drains a joining node once when two shutdown calls arrive before registration returns', async () => {
  const coordinator = createInMemoryCoordinator()
  const network = createInMemoryNetwork()
  const transport = createInMemoryTransport('joining-node', network)
  const registered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const node = await createClusterNode({
    nodeId: 'joining-node',
    address: 'joining-node:9200',
    roles: ['coordinator'],
    transport,
    coordinator: {
      ...coordinator,
      async registerNode(registration) {
        await coordinator.registerNode(registration)
        registered.resolve()
        await release.promise
      },
    },
    engine: { workers: { enabled: false } },
  })
  const starting = node.start().then(
    () => null,
    (error: unknown) => error,
  )
  try {
    await registered.promise
    let stopped = 0
    const first = node.shutdown().then(() => {
      stopped += 1
    })
    const second = node.shutdown().then(() => {
      stopped += 1
    })
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(stopped).toBe(0)
    release.resolve()
    await Promise.all([first, second])
    expect(await starting).toMatchObject({ code: 'NODE_NOT_JOINED' })
    expect(await coordinator.listNodes()).toEqual([])
    expect(node.cluster.getReadiness()).toBe('LEAVING')
    await expect(node.start()).rejects.toMatchObject({ code: 'NODE_NOT_JOINED' })
  } finally {
    release.resolve()
    await starting
    await node.shutdown()
    await transport.shutdown()
    await coordinator.shutdown()
  }
}, 30_000)
