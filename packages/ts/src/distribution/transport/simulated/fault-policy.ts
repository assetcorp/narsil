import { createSeededPrng, deriveStreamSeed } from './prng'

export interface FaultPolicyConfig {
  dropRate?: number
  dropMessageTypes?: string[]
  latencyMinMs?: number
  latencyMaxMs?: number
  partitions?: Array<[string, string]>
}

export interface FaultPolicy {
  shouldDrop(from: string, to: string, messageType: string): boolean
  sampleLatency(from: string, to: string, messageType: string): number
  addPartition(nodeA: string, nodeB: string): void
  removePartition(nodeA: string, nodeB: string): void
  isPartitioned(nodeA: string, nodeB: string): boolean
  setDropRate(rate: number): void
  setDropMessageTypes(messageTypes: string[] | null): void
  setLatencyRange(minMs: number, maxMs: number): void
}

const DROP_STREAM = 'drop'
const LATENCY_STREAM = 'latency'

function partitionKey(a: string, b: string): string {
  return a < b ? `${a}:${b}` : `${b}:${a}`
}

export function createFaultPolicy(config: FaultPolicyConfig, seed: number): FaultPolicy {
  const dropPrng = createSeededPrng(deriveStreamSeed(seed, DROP_STREAM))
  const latencyPrng = createSeededPrng(deriveStreamSeed(seed, LATENCY_STREAM))
  const partitionSet = new Set<string>()
  let dropRate = config.dropRate ?? 0
  let dropMessageTypes: Set<string> | null =
    config.dropMessageTypes === undefined ? null : new Set(config.dropMessageTypes)
  let latencyMinMs = config.latencyMinMs ?? 1
  let latencyMaxMs = config.latencyMaxMs ?? 5

  for (const [a, b] of config.partitions ?? []) {
    partitionSet.add(partitionKey(a, b))
  }

  return {
    shouldDrop(from: string, to: string, messageType: string): boolean {
      const roll = dropPrng.next()
      if (partitionSet.has(partitionKey(from, to))) {
        return true
      }
      if (dropMessageTypes !== null && !dropMessageTypes.has(messageType)) {
        return false
      }
      return dropRate > 0 && roll < dropRate
    },

    sampleLatency(_from: string, _to: string, _messageType: string): number {
      const roll = latencyPrng.next()
      if (latencyMinMs >= latencyMaxMs) {
        return latencyMinMs
      }
      return latencyMinMs + Math.floor(roll * (latencyMaxMs - latencyMinMs))
    },

    addPartition(nodeA: string, nodeB: string): void {
      partitionSet.add(partitionKey(nodeA, nodeB))
    },

    removePartition(nodeA: string, nodeB: string): void {
      partitionSet.delete(partitionKey(nodeA, nodeB))
    },

    isPartitioned(nodeA: string, nodeB: string): boolean {
      return partitionSet.has(partitionKey(nodeA, nodeB))
    },

    setDropRate(rate: number): void {
      dropRate = Math.max(0, Math.min(1, rate))
    },

    setDropMessageTypes(messageTypes: string[] | null): void {
      dropMessageTypes = messageTypes === null ? null : new Set(messageTypes)
    },

    setLatencyRange(minMs: number, maxMs: number): void {
      latencyMinMs = Math.max(0, minMs)
      latencyMaxMs = Math.max(latencyMinMs, maxMs)
    },
  }
}
