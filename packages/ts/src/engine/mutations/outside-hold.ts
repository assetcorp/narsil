import type { IndexHold } from '../index-hold'

export function runOutside<T>(hold: IndexHold | undefined, work: () => Promise<T>): Promise<T> {
  return hold === undefined ? work() : hold.outside(work)
}
