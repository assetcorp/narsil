import type * as CursorPage from './cursor-page'
import { lazyCode } from './lazy-code'

const code = lazyCode('cursor paging', () => import('./cursor-page'))

export function loadCursorPageFor(cursor: string | undefined): Promise<void> | null {
  return cursor === undefined ? null : code.load()
}

export const startAfterAnchor: typeof CursorPage.startAfterAnchor = (...args) => code.get().startAfterAnchor(...args)
