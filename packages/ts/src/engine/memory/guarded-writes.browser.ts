import type * as Mutations from '../mutations'
import { loadOptionalWrites } from '../optional-writes-code'

export { dropEngineIndex } from '../index-lifecycle'
export { insertDocument } from '../mutations/insert'

let mutations: typeof Mutations | undefined

async function loadMutations(): Promise<typeof Mutations> {
  mutations ??= await loadOptionalWrites()
  return mutations
}

export const insertDocumentBatch: typeof Mutations.insertDocumentBatch = async (...args) =>
  (mutations ?? (await loadMutations())).insertDocumentBatch(...args)

export const removeDocument: typeof Mutations.removeDocument = async (...args) =>
  (mutations ?? (await loadMutations())).removeDocument(...args)

export const removeDocumentBatch: typeof Mutations.removeDocumentBatch = async (...args) =>
  (mutations ?? (await loadMutations())).removeDocumentBatch(...args)

export const updateDocument: typeof Mutations.updateDocument = async (...args) =>
  (mutations ?? (await loadMutations())).updateDocument(...args)

export const updateDocumentBatch: typeof Mutations.updateDocumentBatch = async (...args) =>
  (mutations ?? (await loadMutations())).updateDocumentBatch(...args)
