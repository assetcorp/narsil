import { loadNativeCore } from '#platform/native-core'
import { nativeSearchCoreIsEnabled, noteFallback } from '../../vector/native/backend'
import { booleanFacet as portableBooleanFacet } from './boolean'
import { enumFacet as portableEnumFacet } from './enum'
import { numberFacet as portableNumberFacet, rangeFacet as portableRangeFacet } from './numeric'
import { valueFacet as portableValueFacet } from './stored'
import { storedRangeFacet as portableStoredRangeFacet } from './stored-range'

export const storedRangeFacet: typeof portableStoredRangeFacet = (...args) => {
  if (nativeSearchCoreIsEnabled()) {
    const core = loadNativeCore()
    if (core !== null) return core.storedRangeFacet(...args)
    noteFallback('storedRangeFacet')
  }
  return portableStoredRangeFacet(...args)
}

export const valueFacet: typeof portableValueFacet = (...args) => {
  if (nativeSearchCoreIsEnabled()) {
    const core = loadNativeCore()
    if (core !== null) return core.valueFacet(...args)
    noteFallback('valueFacet')
  }
  return portableValueFacet(...args)
}

export const enumFacet: typeof portableEnumFacet = (...args) => {
  if (nativeSearchCoreIsEnabled()) {
    const core = loadNativeCore()
    if (core !== null) return core.enumFacet(...args)
    noteFallback('enumFacet')
  }
  return portableEnumFacet(...args)
}

export const numberFacet: typeof portableNumberFacet = (...args) => {
  if (nativeSearchCoreIsEnabled()) {
    const core = loadNativeCore()
    if (core !== null) return core.numberFacet(...args)
    noteFallback('numberFacet')
  }
  return portableNumberFacet(...args)
}

export const rangeFacet: typeof portableRangeFacet = (...args) => {
  if (nativeSearchCoreIsEnabled()) {
    const core = loadNativeCore()
    if (core !== null) return core.rangeFacet(...args)
    noteFallback('rangeFacet')
  }
  return portableRangeFacet(...args)
}

export const booleanFacet: typeof portableBooleanFacet = (...args) => {
  if (nativeSearchCoreIsEnabled()) {
    const core = loadNativeCore()
    if (core !== null) return core.booleanFacet(...args)
    noteFallback('booleanFacet')
  }
  return portableBooleanFacet(...args)
}
