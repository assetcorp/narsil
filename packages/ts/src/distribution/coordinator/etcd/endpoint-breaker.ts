import type { IOptions } from 'etcd3'
import { ErrorCodes, NarsilError } from '../../../errors'
import { ETCD_ENDPOINT_FAILURE_THRESHOLD, ETCD_ENDPOINT_SKIP_MS } from './constants'

type EndpointPolicy = ReturnType<NonNullable<NonNullable<IOptions['faultHandling']>['host']>>

const NEVER_ABORTED = new AbortController().signal

const noListeners = () => ({ dispose: () => {} })

class EndpointSkippedError extends NarsilError {
  readonly isBrokenCircuitError = true
}

class SkippingEndpointBreaker implements EndpointPolicy {
  declare readonly _altReturn: never
  readonly onSuccess: EndpointPolicy['onSuccess'] = noListeners
  readonly onFailure: EndpointPolicy['onFailure'] = noListeners
  private consecutiveFailures = 0
  private skippedUntil = 0

  constructor(
    private readonly endpoint: string,
    private readonly counts: (error: Error) => boolean,
  ) {}

  async execute<T>(
    fn: (context: { signal: AbortSignal }) => PromiseLike<T> | T,
    signal: AbortSignal = NEVER_ABORTED,
  ): Promise<T> {
    if (Date.now() < this.skippedUntil) {
      throw new EndpointSkippedError(
        ErrorCodes.COORDINATOR_UNAVAILABLE,
        `etcd endpoint ${this.endpoint} failed ${ETCD_ENDPOINT_FAILURE_THRESHOLD} calls in a row, so this client skips it for ${ETCD_ENDPOINT_SKIP_MS} ms`,
        { endpoint: this.endpoint },
      )
    }
    try {
      const result = await fn({ signal })
      this.consecutiveFailures = 0
      return result
    } catch (error) {
      if (error instanceof Error && this.counts(error)) {
        this.consecutiveFailures += 1
        if (this.consecutiveFailures >= ETCD_ENDPOINT_FAILURE_THRESHOLD) {
          this.skippedUntil = Date.now() + ETCD_ENDPOINT_SKIP_MS
        }
      }
      throw error
    }
  }
}

export function createEndpointBreaker(endpoint: string, counts: (error: Error) => boolean): EndpointPolicy {
  return new SkippingEndpointBreaker(endpoint, counts)
}
