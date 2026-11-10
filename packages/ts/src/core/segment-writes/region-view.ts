import type {
  NativeRunTable,
  NativeSpellingTable,
  NativeSurfaceTable,
  NativeTermColumns,
} from '../../vector/native/types/segments'
import type { NativeTermTable } from '../../vector/native/types/terms'

export function termTableView(table: NativeTermTable): NativeTermTable {
  return {
    header: table.header,
    slots: table.slots,
    termOffset: table.termOffset,
    termLength: table.termLength,
    firstUnitNext: table.firstUnitNext,
    firstUnitHead: table.firstUnitHead,
    units: table.units,
  }
}

export function termColumnsView(columns: NativeTermColumns): NativeTermColumns {
  return {
    sliceStart: columns.sliceStart,
    sliceClass: columns.sliceClass,
    lengths: columns.lengths,
    docFrequency: columns.docFrequency,
    deadDocuments: columns.deadDocuments,
    totalTermFrequency: columns.totalTermFrequency,
    surfaceOccurrences: columns.surfaceOccurrences,
    revision: columns.revision,
    flags: columns.flags,
  }
}

export function surfaceTableView(table: NativeSurfaceTable | null): NativeSurfaceTable | null {
  if (table === null) return null
  return { strings: termTableView(table.strings), token: table.token, count: table.count }
}

function runTableView(table: NativeRunTable): NativeRunTable {
  return {
    header: table.header,
    slots: table.slots,
    runs: table.runs,
    listStart: table.listStart,
    listLength: table.listLength,
    listClass: table.listClass,
    members: table.members,
    allocation: table.allocation,
    freeHeads: table.freeHeads,
    sliceCapacities: table.sliceCapacities,
  }
}

export function spellingTableView(table: NativeSpellingTable | null): NativeSpellingTable | null {
  if (table === null) return null
  return {
    strings: termTableView(table.strings),
    token: table.token,
    count: table.count,
    codePoints: table.codePoints,
    runs: runTableView(table.runs),
  }
}

export function holdsTermTable(view: NativeTermTable, table: NativeTermTable): boolean {
  return (
    view.header === table.header &&
    view.slots === table.slots &&
    view.termOffset === table.termOffset &&
    view.termLength === table.termLength &&
    view.firstUnitNext === table.firstUnitNext &&
    view.firstUnitHead === table.firstUnitHead &&
    view.units === table.units
  )
}

export function holdsTermColumns(view: NativeTermColumns, columns: NativeTermColumns): boolean {
  return (
    view.sliceStart === columns.sliceStart &&
    view.sliceClass === columns.sliceClass &&
    view.lengths === columns.lengths &&
    view.docFrequency === columns.docFrequency &&
    view.deadDocuments === columns.deadDocuments &&
    view.totalTermFrequency === columns.totalTermFrequency &&
    view.surfaceOccurrences === columns.surfaceOccurrences &&
    view.revision === columns.revision &&
    view.flags === columns.flags
  )
}

export function holdsSurfaceTable(view: NativeSurfaceTable | null, table: NativeSurfaceTable | null): boolean {
  if (view === null || table === null) return view === table
  return view.token === table.token && view.count === table.count && holdsTermTable(view.strings, table.strings)
}

function holdsRunTable(view: NativeRunTable, table: NativeRunTable): boolean {
  return (
    view.header === table.header &&
    view.slots === table.slots &&
    view.runs === table.runs &&
    view.listStart === table.listStart &&
    view.listLength === table.listLength &&
    view.listClass === table.listClass &&
    view.members === table.members &&
    view.allocation === table.allocation &&
    view.freeHeads === table.freeHeads &&
    view.sliceCapacities === table.sliceCapacities
  )
}

export function holdsSpellingTable(view: NativeSpellingTable | null, table: NativeSpellingTable | null): boolean {
  if (view === null || table === null) return view === table
  return (
    view.token === table.token &&
    view.count === table.count &&
    view.codePoints === table.codePoints &&
    holdsTermTable(view.strings, table.strings) &&
    holdsRunTable(view.runs, table.runs)
  )
}

function isRegionGroup(value: unknown): value is object {
  return typeof value === 'object' && value !== null && !ArrayBuffer.isView(value)
}

export function freezeRegions<Regions extends object>(regions: Regions): Regions {
  for (const key of Object.keys(regions)) {
    const value: unknown = Reflect.get(regions, key)
    if (isRegionGroup(value)) freezeRegions(value)
  }
  return Object.freeze(regions)
}
