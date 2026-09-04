import { describe, expect, it } from 'vitest'
import { dropIdleCopies, noteAccess } from '../../../engine/orchestration/idle'
import { scaleOutBeforeBatch } from '../../../engine/orchestration/scale-out'
import type { CopyTransition } from '../../../engine/orchestration/types'
import { emptyOrchestratorState, type OrchestratorHarness, recordingHarness, registryWith, settle } from './fixtures'

function pendingTransition(kind: CopyTransition['kind']): CopyTransition {
  return { kind, done: new Promise<void>(() => undefined) }
}

async function outcomeOf(work: Promise<void>): Promise<'settled' | 'pending'> {
  return Promise.race([work.then(() => 'settled' as const), settle().then(() => 'pending' as const)])
}

async function driveUntil(harness: OrchestratorHarness, done: () => boolean): Promise<void> {
  for (let round = 0; round < 50 && !done(); round++) {
    await settle()
    harness.releaseAll()
  }
  await settle()
}

describe('scaleOutBeforeBatch', () => {
  it('waits for copies that a threshold load is bringing up', async () => {
    const state = emptyOrchestratorState({ workersEnabled: true })
    state.copyTransitions.set('prose', pendingTransition('load'))

    expect(await outcomeOf(scaleOutBeforeBatch(state, 'prose', 10))).toBe('pending')
  })

  it('lets the batch run on the main copy while copies reload after an idle spell', async () => {
    const state = emptyOrchestratorState({ workersEnabled: true })
    state.copyTransitions.set('prose', pendingTransition('reload'))

    expect(await outcomeOf(scaleOutBeforeBatch(state, 'prose', 10))).toBe('settled')
  })

  it('lets the batch run while an idle drop is in flight', async () => {
    const state = emptyOrchestratorState({ workersEnabled: true })
    state.copyTransitions.set('prose', pendingTransition('drop'))

    expect(await outcomeOf(scaleOutBeforeBatch(state, 'prose', 10))).toBe('settled')
  })
})

describe('an access that arrives while an idle drop is in flight', () => {
  it('queues the reload behind the drop and loads the copies once the drop finishes', async () => {
    const harness = recordingHarness(2, ['prose'], 1, {
      indexRegistry: registryWith('prose'),
      copyIdleTimeoutMs: 1,
    })
    const { state } = harness
    state.lastAccessAt.set('prose', 0)

    const dropping = dropIdleCopies(state, 'prose')
    await settle()
    expect(harness.dispatched.map(entry => entry.action.type)).toEqual(['dropIndex', 'dropIndex'])
    expect(state.copyTransitions.get('prose')?.kind).toBe('drop')

    noteAccess(state, 'prose')
    expect(state.copyTransitions.get('prose')?.kind).toBe('reload')

    await driveUntil(harness, () => !state.copyTransitions.has('prose'))
    await dropping

    expect(state.scaledOutIndexes.has('prose')).toBe(true)
    expect(state.droppedCopies.has('prose')).toBe(false)
    expect(state.copyReloadCounts.get('prose')).toBe(1)
    expect(harness.dispatched.map(entry => entry.action.type)).toEqual([])
  })

  it('joins a reload that an earlier access already queued', async () => {
    const harness = recordingHarness(2, ['prose'], 1, {
      indexRegistry: registryWith('prose'),
      copyIdleTimeoutMs: 1,
    })
    const { state } = harness
    state.lastAccessAt.set('prose', 0)

    const dropping = dropIdleCopies(state, 'prose')
    await settle()
    noteAccess(state, 'prose')
    const queued = state.copyTransitions.get('prose')
    noteAccess(state, 'prose')
    expect(state.copyTransitions.get('prose')).toBe(queued)

    await driveUntil(harness, () => !state.copyTransitions.has('prose'))
    await dropping
    expect(state.copyReloadCounts.get('prose')).toBe(1)
  })
})
