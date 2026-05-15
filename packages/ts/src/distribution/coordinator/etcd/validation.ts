import { ErrorCodes, NarsilError } from '../../../errors'
import type { PartitionState } from '../types'

const MAX_NODE_ID_LENGTH = 255

const VALID_PARTITION_STATES = new Set<string>(['UNASSIGNED', 'INITIALISING', 'ACTIVE', 'MIGRATING', 'DECOMMISSIONING'])

export const MAX_WATCHERS = 64

export function validateNodeId(nodeId: string): void {
  if (nodeId.length === 0) {
    throw new NarsilError(ErrorCodes.CONFIG_INVALID, 'Node ID must not be empty')
  }
  if (nodeId.length > MAX_NODE_ID_LENGTH) {
    throw new NarsilError(ErrorCodes.CONFIG_INVALID, `Node ID exceeds the ${MAX_NODE_ID_LENGTH} character limit`, {
      nodeId,
      length: nodeId.length,
    })
  }
  if (nodeId.includes('/') || nodeId.includes('\\') || nodeId.includes('..') || nodeId.includes('\0')) {
    throw new NarsilError(
      ErrorCodes.CONFIG_INVALID,
      'Node ID contains forbidden characters (/, \\, .., or null bytes)',
      {
        nodeId,
      },
    )
  }
}

export function validatePartitionState(value: string): PartitionState {
  if (!VALID_PARTITION_STATES.has(value)) {
    throw new NarsilError(ErrorCodes.CONFIG_INVALID, `Unknown partition state '${value}'`, {
      state: value,
      validStates: Array.from(VALID_PARTITION_STATES),
    })
  }
  return value as PartitionState
}
