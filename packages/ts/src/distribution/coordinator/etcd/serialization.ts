import { decode, encode } from '@msgpack/msgpack'
import { ErrorCodes, NarsilError } from '../../../errors'
import type { SchemaDefinition } from '../../../types/schema'
import type { AllocationTable, NodeRegistration, PartitionAssignment } from '../types'

interface SerializableAllocationTable {
  indexName: string
  version: number
  replicationFactor: number
  assignments: Array<[number, PartitionAssignment]>
}

export function serializeAllocationTable(table: AllocationTable): Uint8Array {
  const serializable: SerializableAllocationTable = {
    indexName: table.indexName,
    version: table.version,
    replicationFactor: table.replicationFactor,
    assignments: Array.from(table.assignments.entries()),
  }
  return new Uint8Array(encode(serializable))
}

export function deserializeAllocationTable(data: Buffer): AllocationTable {
  const raw = decode(data) as Record<string, unknown>
  if (typeof raw.indexName !== 'string') {
    throw new NarsilError(ErrorCodes.CONFIG_INVALID, 'AllocationTable missing or invalid indexName field')
  }
  if (typeof raw.version !== 'number') {
    throw new NarsilError(ErrorCodes.CONFIG_INVALID, 'AllocationTable missing or invalid version field')
  }
  if (!Array.isArray(raw.assignments)) {
    throw new NarsilError(ErrorCodes.CONFIG_INVALID, 'AllocationTable missing or invalid assignments field')
  }
  return {
    indexName: raw.indexName,
    version: raw.version,
    replicationFactor: typeof raw.replicationFactor === 'number' ? raw.replicationFactor : 0,
    assignments: new Map(raw.assignments as Array<[number, PartitionAssignment]>),
  }
}

export function serializeNodeRegistration(reg: NodeRegistration): Uint8Array {
  return new Uint8Array(encode(reg))
}

export function deserializeNodeRegistration(data: Buffer): NodeRegistration {
  const raw = decode(data) as Record<string, unknown>
  if (typeof raw.nodeId !== 'string') {
    throw new NarsilError(ErrorCodes.CONFIG_INVALID, 'NodeRegistration missing or invalid nodeId field')
  }
  if (typeof raw.address !== 'string') {
    throw new NarsilError(ErrorCodes.CONFIG_INVALID, 'NodeRegistration missing or invalid address field')
  }
  return raw as unknown as NodeRegistration
}

export function serializeSchema(schema: SchemaDefinition): Buffer {
  return Buffer.from(new Uint8Array(encode(schema)))
}

export function deserializeSchema(data: Buffer): SchemaDefinition {
  return decode(data) as SchemaDefinition
}
