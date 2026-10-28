import { synonymSearchModule } from './module'
import type { SynonymSearchModule } from './types'

export function platformSynonymSearch(): SynonymSearchModule | null {
  return synonymSearchModule
}
