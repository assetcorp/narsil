import { bindSearchSignal } from '../../core/search-stop'
import { ErrorCodes, NarsilError } from '../../errors'
import type { PartitionManager } from '../../partitioning/manager'
import type { StatePin } from '../../partitioning/manager/state-pins'
import type { ScanTurns } from '../../search/fulltext'

export interface SearchTry extends ScanTurns {
  readonly pin: StatePin
  releaseRetrieval(): void
}

export function requirePinnedState(pin: StatePin | undefined): void {
  if (pin !== undefined && pin.changed.size > 0) {
    throw new NarsilError(ErrorCodes.SEARCH_STATE_MOVED, 'A write changed a state during its retrieval')
  }
}

class PinnedTry implements SearchTry {
  constructor(
    readonly pin: StatePin,
    readonly releaseRetrieval: () => void,
    readonly signal?: AbortSignal,
  ) {
    bindSearchSignal(this, signal)
  }

  afterYield(): void {
    this.signal?.throwIfAborted()
    requirePinnedState(this.pin)
  }
}

export function answerFromOneState<T>(
  manager: PartitionManager,
  answer: (attempt: SearchTry) => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  return manager.publication.read(async release => {
    signal?.throwIfAborted()
    const pin = manager.pinState()
    try {
      const result = await answer(new PinnedTry(pin, release, signal))
      signal?.throwIfAborted()
      return result
    } finally {
      pin.release()
    }
  })
}
