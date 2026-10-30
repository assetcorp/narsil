import { decode, encode } from '@msgpack/msgpack'
import { createInMemoryTransport, type InMemoryNetwork } from '../../../distribution/transport'
import { type NodeTransport, TransportError, TransportErrorCodes } from '../../../distribution/transport/types'

export interface SearchRecord {
  round: number
  target: string
  keepAliveMs: number | null
  contextId: string | null
  rankedIds: string[]
}

export interface FetchRecord {
  round: number
  target: string
  contextId: string | null
  releaseContext: boolean | null
  docIds: string[]
  sentAt: number
  answeredAt: number | null
  errorCode: string | null
}

export interface RankedContext {
  target: string
  contextId: string
}

export interface WireTap {
  transport: NodeTransport
  searches: SearchRecord[]
  fetches: FetchRecord[]
  rounds(): number
  betweenPhases: ((round: number, contexts: RankedContext[]) => Promise<void>) | null
  afterSearch: ((record: SearchRecord) => Promise<void>) | null
  afterFetch: ((record: FetchRecord) => Promise<void>) | null
  rewriteSearch: ((payload: Record<string, unknown>, round: number) => void) | null
  rewriteSearchResult: ((payload: Record<string, unknown>) => void) | null
  unreachable: ((target: string, round: number) => boolean) | null
}

export function tapTransport(nodeId: string, network: InMemoryNetwork): WireTap {
  const inner = createInMemoryTransport(nodeId, network)
  let round = 0
  let fetchedThisRound = true
  let tick = 0
  const pauses = new Map<number, Promise<void>>()

  const tap: WireTap = {
    searches: [],
    fetches: [],
    rounds: () => round,
    betweenPhases: null,
    afterSearch: null,
    afterFetch: null,
    rewriteSearch: null,
    rewriteSearchResult: null,
    unreachable: null,
    transport: {
      ...inner,
      async send(target, message) {
        if (message.type === 'query.search') {
          if (fetchedThisRound) {
            round += 1
            fetchedThisRound = false
          }
          const searchRound = round
          const payload = decode(message.payload) as Record<string, unknown>
          tap.rewriteSearch?.(payload, searchRound)
          const response = await inner.send(target, { ...message, payload: encode(payload) })
          const answer = decode(response.payload) as Record<string, unknown>
          tap.rewriteSearchResult?.(answer)
          const partitions = Array.isArray(answer.results) ? (answer.results as Array<{ scored: unknown[] }>) : []
          const record: SearchRecord = {
            round: searchRound,
            target,
            keepAliveMs: typeof payload.keepAliveMs === 'number' ? payload.keepAliveMs : null,
            contextId: typeof answer.contextId === 'string' ? answer.contextId : null,
            rankedIds: partitions.flatMap(partition =>
              partition.scored.map(entry => String((entry as { docId: unknown }).docId)),
            ),
          }
          tap.searches.push(record)
          await tap.afterSearch?.(record)
          return { ...response, payload: encode(answer) }
        }
        if (message.type !== 'query.fetch') return inner.send(target, message)

        fetchedThisRound = true
        const fetchRound = round
        const payload = decode(message.payload) as Record<string, unknown>
        const contextId = typeof payload.contextId === 'string' ? payload.contextId : null
        const documentIds = Array.isArray(payload.documentIds) ? payload.documentIds : []
        if (contextId !== null && documentIds.length > 0 && tap.betweenPhases !== null) {
          const hook = tap.betweenPhases
          let pause = pauses.get(fetchRound)
          if (pause === undefined) {
            const contexts = tap.searches
              .filter(search => search.round === fetchRound && search.contextId !== null)
              .map(search => ({ target: search.target, contextId: search.contextId ?? '' }))
            pause = hook(fetchRound, contexts)
            pauses.set(fetchRound, pause)
          }
          await pause
        }
        const record: FetchRecord = {
          round: fetchRound,
          target,
          contextId,
          releaseContext: typeof payload.releaseContext === 'boolean' ? payload.releaseContext : null,
          docIds: documentIds.map(entry => String((entry as { docId: unknown }).docId)),
          sentAt: ++tick,
          answeredAt: null,
          errorCode: null,
        }
        tap.fetches.push(record)
        if (contextId !== null && tap.unreachable?.(target, fetchRound) === true) {
          record.errorCode = TransportErrorCodes.CONNECT_FAILED
          throw new TransportError(TransportErrorCodes.CONNECT_FAILED, `node '${target}' is unreachable`)
        }
        const response = await inner.send(target, message)
        record.answeredAt = ++tick
        const answer = decode(response.payload) as Record<string, unknown>
        if (typeof answer.code === 'string') record.errorCode = answer.code
        await tap.afterFetch?.(record)
        return response
      },
    },
  }
  return tap
}
