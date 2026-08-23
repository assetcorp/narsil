import { describe, expect, it } from 'vitest'
import type { ClusterNodeConfig, ClusterQueryConfig } from '../../../distribution/cluster-node/types'
import { validateClusterNodeConfig } from '../../../distribution/cluster-node/validate-config'
import { createInMemoryCoordinator } from '../../../distribution/coordinator'
import { createInMemoryNetwork, createInMemoryTransport } from '../../../distribution/transport'
import { ErrorCodes, NarsilError } from '../../../errors'

function configWithQuery(query: ClusterQueryConfig): ClusterNodeConfig {
  const network = createInMemoryNetwork()
  return {
    coordinator: createInMemoryCoordinator(),
    transport: createInMemoryTransport('node-a', network),
    address: 'node-a:9200',
    query,
  }
}

describe('the query settings a cluster node accepts', () => {
  it('accepts a whole number of milliseconds', () => {
    expect(() => validateClusterNodeConfig(configWithQuery({ partitionTimeout: 250 }))).not.toThrow()
  })

  it('accepts a node that names neither setting', () => {
    expect(() => validateClusterNodeConfig(configWithQuery({}))).not.toThrow()
  })

  it('refuses an allowPartialResults that is not a boolean', () => {
    let thrown: unknown
    try {
      validateClusterNodeConfig(configWithQuery({ allowPartialResults: 'yes' } as unknown as ClusterQueryConfig))
    } catch (err) {
      thrown = err
    }
    expect(thrown).toBeInstanceOf(NarsilError)
    expect((thrown as NarsilError).code).toBe(ErrorCodes.CONFIG_INVALID)
  })

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])('refuses a partitionTimeout of %p', partitionTimeout => {
    let thrown: unknown
    try {
      validateClusterNodeConfig(configWithQuery({ partitionTimeout }))
    } catch (err) {
      thrown = err
    }
    expect(thrown).toBeInstanceOf(NarsilError)
    expect((thrown as NarsilError).code).toBe(ErrorCodes.CONFIG_INVALID)
  })
})
