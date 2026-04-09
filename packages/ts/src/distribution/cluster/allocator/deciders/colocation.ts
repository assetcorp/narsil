import type { Decider, DeciderContext, DeciderVerdict } from '../types'

export const colocationDecider: Decider = {
  name: 'colocation',

  canAllocate(context: DeciderContext): DeciderVerdict {
    const { currentAssignment, candidateNodeId, role } = context

    if (currentAssignment === undefined) {
      return 'YES'
    }

    if (role === 'primary') {
      if (currentAssignment.replicas.includes(candidateNodeId)) {
        return 'NO'
      }
      return 'YES'
    }

    if (currentAssignment.primary === candidateNodeId) {
      return 'NO'
    }

    if (currentAssignment.replicas.includes(candidateNodeId)) {
      return 'NO'
    }

    return 'YES'
  },
}
