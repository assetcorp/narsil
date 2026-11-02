import { MAX_REPLICATION_FACTOR } from '../constants'
import type { AllocationConstraints } from '../coordinator/types'
import { isValidInteger } from '../payload-guards'
import { readAllocationConstraints } from './manifest'

export interface RestorePlacement {
  replicationFactor?: number
  constraints?: AllocationConstraints
}

export function readRestorePlacement(request: Record<string, unknown>): RestorePlacement | string {
  const { replicationFactor, constraints } = request
  const placement: RestorePlacement = {}
  if (replicationFactor !== undefined && replicationFactor !== null) {
    if (!isValidInteger(replicationFactor) || replicationFactor < 0 || replicationFactor > MAX_REPLICATION_FACTOR) {
      return `"replicationFactor" must be an integer from 0 to ${MAX_REPLICATION_FACTOR}`
    }
    placement.replicationFactor = replicationFactor
  }
  if (constraints !== undefined && constraints !== null) {
    const read = readAllocationConstraints(constraints)
    if (read === null) {
      return '"constraints" must hold "zoneAwareness" as a boolean, "zoneAttribute" as a non-empty string, and "maxShardsPerNode" as a positive integer or null'
    }
    placement.constraints = read
  }
  return placement
}
