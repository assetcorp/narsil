import type { QueryParams, QueryResult, SuggestParams, SuggestResult } from '@delali/narsil'
import { createContext, useContext } from 'react'

/** Runs one search and answers with the engine's own result. */
export type QueryRunner = (indexName: string, params: QueryParams, signal?: AbortSignal) => Promise<QueryResult>

/** Completes one prefix against an index. */
export type SuggestRunner = (indexName: string, params: SuggestParams, signal?: AbortSignal) => Promise<SuggestResult>

/**
 * The two calls the panels fire in bursts rather than through a hook. Each app
 * supplies them over the transport it uses, so the panels stay the same whether
 * the engine answers over HTTP or from a worker.
 */
export interface SearchRunners {
  query: QueryRunner
  suggest: SuggestRunner
}

export const SearchRunnersContext = createContext<SearchRunners | null>(null)

function useSearchRunners(): SearchRunners {
  const runners = useContext(SearchRunnersContext)
  if (runners === null) {
    throw new Error('The search runners must be provided through SearchRunnersContext')
  }
  return runners
}

export function useQueryRunner(): QueryRunner {
  return useSearchRunners().query
}

export function useSuggestRunner(): SuggestRunner {
  return useSearchRunners().suggest
}
