import type { AllocationConstraints, Decider, DeciderContext, DeciderVerdict } from '../types'
import { balanceDecider } from './balance'
import { createCapacityDecider } from './capacity'
import { colocationDecider } from './colocation'
import { createMaxShardsDecider } from './max-shards'
import { createZoneDecider } from './zone'

export function createDeciderChain(constraints: AllocationConstraints, estimatedPartitionBytes?: number): Decider[] {
  const deciders: Decider[] = [
    colocationDecider,
    createMaxShardsDecider(constraints.maxShardsPerNode),
    createCapacityDecider(estimatedPartitionBytes),
  ]

  if (constraints.zoneAwareness) {
    deciders.push(createZoneDecider(constraints.zoneAttribute))
  }

  deciders.push(balanceDecider)

  return deciders
}

export function runDeciders(deciders: Decider[], context: DeciderContext): DeciderVerdict {
  let hasThrottle = false

  for (const decider of deciders) {
    const verdict = decider.canAllocate(context)
    if (verdict === 'NO') return 'NO'
    if (verdict === 'THROTTLE') hasThrottle = true
  }

  return hasThrottle ? 'THROTTLE' : 'YES'
}

export { balanceDecider } from './balance'
export { createCapacityDecider } from './capacity'
export { colocationDecider } from './colocation'
export { createMaxShardsDecider } from './max-shards'
export { createZoneDecider } from './zone'
