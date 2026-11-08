const textByRecords = new WeakMap<Uint32Array, ReadonlyArray<string | undefined>>()

export function recordTokenText(records: Uint32Array, text: ReadonlyArray<string | undefined>): void {
  textByRecords.set(records, text)
}

export function tokenTextOf(records: unknown): ReadonlyArray<string | undefined> | undefined {
  return typeof records === 'object' && records !== null ? textByRecords.get(records as Uint32Array) : undefined
}
