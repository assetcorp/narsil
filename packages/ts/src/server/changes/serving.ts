import type { ChangeSource } from '../../changes/source'

export interface ChangesServing {
  source: ChangeSource
  admitFeed(indexName: string): Promise<void>
}

const changesServingSources = new WeakMap<object, () => ChangesServing>()

export function bindChangesServing(owner: object, serving: () => ChangesServing): void {
  changesServingSources.set(owner, serving)
}

export function changesServingSourceOf(owner: object): (() => ChangesServing) | undefined {
  return changesServingSources.get(owner)
}
