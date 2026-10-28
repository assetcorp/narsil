import type { Decider, DeciderContext, DeciderVerdict } from '../types'

export const drainingDecider: Decider = {
  name: 'draining',

  canAllocate(context: DeciderContext): DeciderVerdict {
    return context.nodes.get(context.candidateNodeId)?.draining === true ? 'NO' : 'YES'
  },
}
