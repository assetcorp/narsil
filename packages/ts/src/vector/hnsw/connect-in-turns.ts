import { backgroundTurnIsSpent, holdWrites, turnsAreBudgeted, yieldBackgroundTurn } from '#platform/shared-turns'
import { GRAPH_LOCK_WAIT_DEADLINE_MS } from '../constants'
import { type NativeField, nativeFieldFor } from '../native/field'
import { nativeConnectOffThread, nativeConnectsOffThread } from '../native/writes'
import type { Steps } from './connect-steps'
import { connectAfterBuild, connectInJsSteps } from './connect-unreached'
import { CONNECT_RESTARTS_BEFORE_ONE_PASS } from './constants'
import { GRAPH_UNLINKED_NODES } from './handles'
import { lockGraphExclusive, unlockGraphExclusive } from './locks'
import type { HNSWGraphState } from './shared'

function connectHoldingTheGraph(state: HNSWGraphState): void {
  lockGraphExclusive(state.locks)
  try {
    connectAfterBuild(state)
  } finally {
    unlockGraphExclusive(state.locks)
  }
}

function sliceFinished(state: HNSWGraphState, steps: Steps): boolean {
  lockGraphExclusive(state.locks)
  try {
    for (;;) {
      if (steps.next().done === true) {
        Atomics.store(state.header, GRAPH_UNLINKED_NODES, 0)
        return true
      }
      if (backgroundTurnIsSpent()) return false
    }
  } finally {
    unlockGraphExclusive(state.locks)
  }
}

async function connectedWithoutLinkWrites(state: HNSWGraphState): Promise<boolean> {
  const writesBefore = state.linkWrites
  const steps = connectInJsSteps(state)
  while (!sliceFinished(state, steps)) {
    await yieldBackgroundTurn()
    if (state.linkWrites !== writesBefore) return false
  }
  return state.linkWrites === writesBefore
}

async function connectUntilWritesDrain(state: HNSWGraphState): Promise<void> {
  let connected = false
  while (!connected) connected = await connectedWithoutLinkWrites(state)
}

async function connectInSlices(state: HNSWGraphState): Promise<void> {
  for (let restarts = 0; restarts < CONNECT_RESTARTS_BEFORE_ONE_PASS; restarts++) {
    if (await connectedWithoutLinkWrites(state)) return
  }
  if (turnsAreBudgeted) await holdWrites(() => connectUntilWritesDrain(state))
  else connectHoldingTheGraph(state)
}

async function connectThroughTheCoreThread(state: HNSWGraphState, first: NativeField): Promise<boolean> {
  const startedAt = performance.now()
  let field: NativeField | null = first
  while (field !== null) {
    const outcome = await nativeConnectOffThread(state, field, state.buildMetric)
    if (outcome === 'connected') return true
    if (outcome === 'failed' || performance.now() - startedAt >= GRAPH_LOCK_WAIT_DEADLINE_MS) return false
    await yieldBackgroundTurn()
    field = nativeFieldFor(state)
  }
  return false
}

export function connectOffThread(state: HNSWGraphState): Promise<boolean> | null {
  const field = nativeFieldFor(state)
  if (field === null || !nativeConnectsOffThread(field)) return null
  return connectThroughTheCoreThread(state, field)
}

export function connectOnThisThread(state: HNSWGraphState, inSlices: boolean): Promise<void> {
  if (inSlices || nativeFieldFor(state) === null) return connectInSlices(state)
  connectHoldingTheGraph(state)
  return Promise.resolve()
}
