import type { PartitionReadState } from './read-state'

export function partitionDocumentFrequency(subs: readonly PartitionReadState[], token: string): number {
  let documents = 0
  for (const sub of subs) documents += sub.invertedIdx.documentFrequency(token)
  return documents
}
