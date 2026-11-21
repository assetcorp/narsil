import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { ClusterCoordinator, NodeEvent, SchemaEvent } from '../../../../distribution/coordinator'
import { createEtcdCoordinator } from '../../../../distribution/coordinator'
import {
  type EtcdContainerHandle,
  eventually,
  MANAGED_ETCD_ENDPOINT,
  makeNodeRegistration,
  runDocker,
  startEtcdContainer,
  stopEtcdContainer,
  testSchema,
  waitForEtcdReady,
} from './fixtures'

const EVENT_WAIT_MS = 10_000

interface Tenant {
  name: string
  coordinator: ClusterCoordinator
  nodeEvents: string[]
  schemaEvents: string[]
  stopWatching: Array<() => void>
}

function describeNodeEvent(event: NodeEvent): string {
  return `${event.type} ${event.nodeId}`
}

function describeSchemaEvent(event: SchemaEvent): string {
  return `${event.type} ${event.indexName}`
}

describe('EtcdCoordinator integration - clusters whose key prefixes nest', () => {
  let container: EtcdContainerHandle | null = null

  beforeAll(async () => {
    if (MANAGED_ETCD_ENDPOINT !== null) {
      container = { endpoint: MANAGED_ETCD_ENDPOINT, name: null }
      await waitForEtcdReady(MANAGED_ETCD_ENDPOINT)
      return
    }

    await runDocker(['version'])
    container = await startEtcdContainer()
  }, 90_000)

  afterAll(async () => {
    await stopEtcdContainer(container?.name ?? null)
    container = null
  }, 30_000)

  it('lists and watches only the nodes and schemas under its own prefix', async () => {
    if (container === null) {
      throw new Error('Etcd integration container is not available')
    }
    const endpoint = container.endpoint
    const outerPrefix = `_narsil_nested_${randomUUID()}`
    const tenants: Tenant[] = []
    for (const [name, keyPrefix] of [
      ['outer', outerPrefix],
      ['nodes-eu', `${outerPrefix}/nodes-eu`],
      ['schema-eu', `${outerPrefix}/schema-eu`],
      ['nodes', `${outerPrefix}/nodes`],
      ['schema', `${outerPrefix}/schema`],
    ] as const) {
      const coordinator = await createEtcdCoordinator({ endpoints: [endpoint], keyPrefix, nodeHeartbeatTtlSeconds: 5 })
      const tenant: Tenant = { name, coordinator, nodeEvents: [], schemaEvents: [], stopWatching: [] }
      tenant.stopWatching.push(await coordinator.watchNodes(event => tenant.nodeEvents.push(describeNodeEvent(event))))
      tenant.stopWatching.push(
        await coordinator.watchSchemas(event => tenant.schemaEvents.push(describeSchemaEvent(event))),
      )
      tenants.push(tenant)
    }

    try {
      for (const tenant of [...tenants].reverse()) {
        await tenant.coordinator.registerNode(makeNodeRegistration({ nodeId: `${tenant.name}-node` }))
        await tenant.coordinator.putSchema(`${tenant.name}-catalogue`, testSchema)
      }

      for (const tenant of tenants) {
        const nodeIds = (await tenant.coordinator.listNodes()).map(node => node.nodeId)
        expect(nodeIds).toEqual([`${tenant.name}-node`])
        expect(await tenant.coordinator.listSchemas()).toEqual([`${tenant.name}-catalogue`])
      }

      for (const tenant of [...tenants].reverse()) {
        await tenant.coordinator.deregisterNode(`${tenant.name}-node`)
        await tenant.coordinator.dropSchema(`${tenant.name}-catalogue`)
      }

      for (const tenant of tenants) {
        await eventually(
          async () => {
            expect(tenant.nodeEvents).toContain(`node_left ${tenant.name}-node`)
            expect(tenant.schemaEvents).toContain(`schema_dropped ${tenant.name}-catalogue`)
          },
          EVENT_WAIT_MS,
          `The ${tenant.name} cluster never received its own events`,
        )
        expect(tenant.nodeEvents).toEqual([`node_joined ${tenant.name}-node`, `node_left ${tenant.name}-node`])
        expect(tenant.schemaEvents).toEqual([
          `schema_created ${tenant.name}-catalogue`,
          `schema_dropped ${tenant.name}-catalogue`,
        ])
      }
    } finally {
      for (const tenant of tenants) {
        for (const stop of tenant.stopWatching) stop()
        await tenant.coordinator.shutdown()
      }
    }
  }, 60_000)
})
