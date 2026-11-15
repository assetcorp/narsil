import type {
  OnRequestHook,
  QueryIdentity,
  RequestContext,
  RequestDenial,
  ServerQuerySuggestionsOptions,
} from '@delali/narsil/server'
import { GROUP_HEADER, GROUP_PATTERN, MAX_PERSON_UTF16_UNITS, PERSON_HEADER } from './constants'
import type { Credential, CredentialVerifier } from './credentials'
import { routeAccessOf } from './routes'

export { createCredentialVerifier } from './credentials'

const UNAUTHORIZED: RequestDenial = {
  status: 401,
  code: 'UNAUTHORIZED',
  message: 'This route needs a valid key or token as Authorization: Bearer',
}

const OUTSIDE_ROLE: RequestDenial = {
  status: 403,
  code: 'FORBIDDEN',
  message: 'This credential grants the read routes alone',
}

const OUTSIDE_INDEXES: RequestDenial = {
  status: 403,
  code: 'FORBIDDEN',
  message: 'This token reaches only the routes of the indexes that it lists',
}

const SECONDS_TO_MS = 1000

export function createAccessHook(verifier: CredentialVerifier): OnRequestHook {
  return ctx => {
    const route = routeAccessOf(ctx.method, ctx.path)
    if (route.probe) return undefined
    const credential = verifier.verify(ctx)
    if (credential === null) return UNAUTHORIZED
    if (credential.role === 'read' && !route.read) return OUTSIDE_ROLE
    if (credential.kind === 'key') return undefined
    const { indexes, expiresAtSeconds } = credential.token
    if (indexes !== null && (route.indexName === null || !indexes.has(route.indexName))) return OUTSIDE_INDEXES
    return { expiresAt: expiresAtSeconds * SECONDS_TO_MS }
  }
}

function identityOf(person: string | undefined, group: string | undefined): QueryIdentity | null {
  if (person === undefined || group === undefined) return null
  if (person.length < 1 || person.length > MAX_PERSON_UTF16_UNITS) return null
  if (!GROUP_PATTERN.test(group)) return null
  return { person, group }
}

function identityOfCredential(credential: Credential | null, ctx: RequestContext): QueryIdentity | null {
  if (credential === null) return null
  if (credential.kind === 'token') return identityOf(credential.token.subject, credential.token.group)
  if (credential.role !== 'admin') return null
  return identityOf(ctx.headers[PERSON_HEADER], ctx.headers[GROUP_HEADER])
}

export function createQueryIdentity(verifier: CredentialVerifier): ServerQuerySuggestionsOptions {
  return { identify: ctx => identityOfCredential(verifier.verify(ctx), ctx) }
}
