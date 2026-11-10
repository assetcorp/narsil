import { loadNativeCore } from '#platform/native-core'
import { nativeSearchCoreIsEnabled, noteFallback } from '../../vector/native/backend'
import type { FilterProgram } from './layout'
import { evaluateFilter as portable } from './portable'

export function evaluateFilter(program: FilterProgram, into: Uint32Array): number {
  if (nativeSearchCoreIsEnabled()) {
    const core = loadNativeCore()
    if (core !== null)
      return core.evaluateFilter(
        program.plan,
        program.numbers,
        program.units,
        program.offsets,
        program.lists,
        program.bitsets,
        program.kinds,
        program.fields,
        program.live,
        into,
      )
    noteFallback('evaluateFilter')
  }
  return portable(program, into)
}
