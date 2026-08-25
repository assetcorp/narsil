import { NODES } from '../topology'
import type { LinkKind } from './cluster-types'

const MAX_TERM_LENGTH = 128

export interface LinkInput {
  nodeId: string
  kind: LinkKind
  enabled: boolean
}

export interface ProbeInput {
  nodeId: string
  term: string
}

export interface ProvisionInput {
  nodeId: string
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Expected an object payload')
  }
  return value as Record<string, unknown>
}

function parseNodeId(value: unknown): string {
  if (typeof value !== 'string' || !NODES.some(spec => spec.nodeId === value)) {
    throw new Error(`Expected one of ${NODES.map(spec => spec.nodeId).join(', ')}`)
  }
  return value
}

export function parseLinkInput(value: unknown): LinkInput {
  const record = asRecord(value)
  const kind = record.kind
  if (kind !== 'coordinator' && kind !== 'replication') {
    throw new Error("Expected kind to be 'coordinator' or 'replication'")
  }
  if (typeof record.enabled !== 'boolean') {
    throw new Error('Expected enabled to be a boolean')
  }
  return { nodeId: parseNodeId(record.nodeId), kind, enabled: record.enabled }
}

export function parseProbeInput(value: unknown): ProbeInput {
  const record = asRecord(value)
  if (typeof record.term !== 'string' || record.term.trim().length === 0) {
    throw new Error('Expected a search term')
  }
  if (record.term.length > MAX_TERM_LENGTH) {
    throw new Error(`A search term may not exceed ${MAX_TERM_LENGTH} characters`)
  }
  return { nodeId: parseNodeId(record.nodeId), term: record.term.trim() }
}

export function parseProvisionInput(value: unknown): ProvisionInput {
  const record = asRecord(value)
  return { nodeId: parseNodeId(record.nodeId) }
}
