import { partialWordSearchModule } from './module'
import type { PartialWordSearchModule } from './types'

export function platformPartialWordSearch(): PartialWordSearchModule | null {
  return partialWordSearchModule
}
