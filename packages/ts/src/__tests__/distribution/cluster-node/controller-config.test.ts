import { describe, expect, it } from 'vitest'
import type { ClusterControllerConfig, ClusterNodeConfig } from '../../../distribution/cluster-node/types'
import { validateClusterNodeConfig } from '../../../distribution/cluster-node/validate-config'
import { createInMemoryCoordinator } from '../../../distribution/coordinator'
import { createInMemoryNetwork, createInMemoryTransport } from '../../../distribution/transport'
import { ErrorCodes, NarsilError } from '../../../errors'

function configWithController(controller: ClusterControllerConfig): ClusterNodeConfig {
  const network = createInMemoryNetwork()
  return {
    coordinator: createInMemoryCoordinator(),
    transport: createInMemoryTransport('node-a', network),
    address: 'node-a:9200',
    controller,
  }
}

function codeOf(controller: ClusterControllerConfig): unknown {
  try {
    validateClusterNodeConfig(configWithController(controller))
  } catch (err) {
    return err instanceof NarsilError ? err.code : err
  }
  return null
}

describe('the controller settings a cluster node accepts', () => {
  it('accepts a lease and a retry given in whole milliseconds', () => {
    expect(() =>
      validateClusterNodeConfig(configWithController({ leaseTtlMs: 5_000, standbyRetryMs: 1_000 })),
    ).not.toThrow()
  })

  it('accepts a node that names neither setting', () => {
    expect(() => validateClusterNodeConfig(configWithController({}))).not.toThrow()
  })

  it.each([
    999,
    0,
    -1,
    1.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
  ])('refuses a leaseTtlMs of %p, which etcd cannot hold', leaseTtlMs => {
    expect(codeOf({ leaseTtlMs })).toBe(ErrorCodes.CONFIG_INVALID)
  })

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])('refuses a standbyRetryMs of %p', standbyRetryMs => {
    expect(codeOf({ standbyRetryMs })).toBe(ErrorCodes.CONFIG_INVALID)
  })
})
