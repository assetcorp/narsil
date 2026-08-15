import { createNarsilClient } from '@delali/narsil/client'

export const NARSIL_PROXY_PATH = '/api/narsil'

/**
 * The client the pages use. It points at this app rather than at the search
 * server, because anybody can read what a browser bundle was built with and
 * the API key has to stay on the server.
 */
export const narsilClient = createNarsilClient({ url: NARSIL_PROXY_PATH })
