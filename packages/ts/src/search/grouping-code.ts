import type { GroupConfig } from '../types/search'
import type * as Grouping from './grouping'
import { lazyCode } from './lazy-code'

const code = lazyCode('grouping', () => import('./grouping'))

export function loadGroupingFor(group: GroupConfig | undefined): Promise<void> | null {
  return group === undefined ? null : code.load()
}

export const applyGrouping: typeof Grouping.applyGrouping = (...args) => code.get().applyGrouping(...args)
export const requireGroupableFields: typeof Grouping.requireGroupableFields = (...args) =>
  code.get().requireGroupableFields(...args)
