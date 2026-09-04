import { ErrorCodes, NarsilError } from '../../errors'
import type { NodeRole } from '../coordinator/types'
import { MAX_WAIT_FOR_ACTIVE_REPLICAS, MIN_CONTROLLER_LEASE_TTL_MS } from './constants'
import type { ClusterNodeConfig } from './types'

export function validateClusterNodeConfig(config: ClusterNodeConfig): void {
  if (config.address.length === 0) {
    throw new NarsilError(ErrorCodes.CONFIG_INVALID, 'ClusterNodeConfig.address must not be empty')
  }

  if (config.roles !== undefined) {
    if (config.roles.length === 0) {
      throw new NarsilError(ErrorCodes.CONFIG_INVALID, 'ClusterNodeConfig.roles must contain at least one role')
    }

    const validRoles = new Set<NodeRole>(['data', 'coordinator', 'controller'])
    for (const role of config.roles) {
      if (!validRoles.has(role)) {
        throw new NarsilError(ErrorCodes.CONFIG_INVALID, `Invalid role: '${role}'`, { role })
      }
    }
  }

  if (config.capacity !== undefined) {
    if (config.capacity.memoryBytes <= 0 || !Number.isFinite(config.capacity.memoryBytes)) {
      throw new NarsilError(
        ErrorCodes.CONFIG_INVALID,
        'ClusterNodeConfig.capacity.memoryBytes must be a positive finite number',
      )
    }
    if (config.capacity.cpuCores <= 0 || !Number.isInteger(config.capacity.cpuCores)) {
      throw new NarsilError(ErrorCodes.CONFIG_INVALID, 'ClusterNodeConfig.capacity.cpuCores must be a positive integer')
    }
  }

  if (config.replication !== undefined) {
    const { logRetentionBytes, waitForActiveReplicas } = config.replication
    if (logRetentionBytes !== undefined && (!Number.isInteger(logRetentionBytes) || logRetentionBytes <= 0)) {
      throw new NarsilError(
        ErrorCodes.CONFIG_INVALID,
        'ClusterNodeConfig.replication.logRetentionBytes must be a positive integer',
        { logRetentionBytes },
      )
    }
    if (
      waitForActiveReplicas !== undefined &&
      (!Number.isInteger(waitForActiveReplicas) ||
        waitForActiveReplicas < 1 ||
        waitForActiveReplicas > MAX_WAIT_FOR_ACTIVE_REPLICAS)
    ) {
      throw new NarsilError(
        ErrorCodes.CONFIG_INVALID,
        `ClusterNodeConfig.replication.waitForActiveReplicas must be an integer between 1 and ${MAX_WAIT_FOR_ACTIVE_REPLICAS}`,
        { waitForActiveReplicas },
      )
    }
  }

  if (config.query !== undefined) {
    const { allowPartialResults, partitionTimeout } = config.query
    if (allowPartialResults !== undefined && typeof allowPartialResults !== 'boolean') {
      throw new NarsilError(
        ErrorCodes.CONFIG_INVALID,
        'ClusterNodeConfig.query.allowPartialResults must be a boolean',
        {
          allowPartialResults,
        },
      )
    }
    if (partitionTimeout !== undefined && (!Number.isInteger(partitionTimeout) || partitionTimeout <= 0)) {
      throw new NarsilError(
        ErrorCodes.CONFIG_INVALID,
        'ClusterNodeConfig.query.partitionTimeout must be a positive integer',
        { partitionTimeout },
      )
    }
  }

  if (config.controller !== undefined) {
    const { leaseTtlMs, standbyRetryMs } = config.controller
    if (leaseTtlMs !== undefined && (!Number.isInteger(leaseTtlMs) || leaseTtlMs < MIN_CONTROLLER_LEASE_TTL_MS)) {
      throw new NarsilError(
        ErrorCodes.CONFIG_INVALID,
        `ClusterNodeConfig.controller.leaseTtlMs must be an integer of at least ${MIN_CONTROLLER_LEASE_TTL_MS}`,
        { leaseTtlMs },
      )
    }
    if (standbyRetryMs !== undefined && (!Number.isInteger(standbyRetryMs) || standbyRetryMs <= 0)) {
      throw new NarsilError(
        ErrorCodes.CONFIG_INVALID,
        'ClusterNodeConfig.controller.standbyRetryMs must be a positive integer',
        { standbyRetryMs },
      )
    }
  }
}
