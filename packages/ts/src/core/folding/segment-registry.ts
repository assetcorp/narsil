import { type PreparedText, visitPreparedSpellings } from '../partition/prepared-text'
import type { PartitionReadState } from '../partition/read-state'

export interface FoldedSpellingSink {
  note(spelling: string, token: string): void
}

export const foldedSpellingSinks = new WeakMap<PartitionReadState, FoldedSpellingSink>()

export function noteFoldedSpellings(state: PartitionReadState, prepared: PreparedText): void {
  const sink = foldedSpellingSinks.get(state)
  if (sink === undefined) return
  const note = (spelling: string, token: string): void => sink.note(spelling, token)
  for (const field of prepared.fields.values()) visitPreparedSpellings(field, note)
}
