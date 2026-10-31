import { resolve } from 'node:path'
import ts from 'typescript'
import type { RouteRequestBody, RouteResponseBody, RouteSpec } from '../../src/server/routes'
import type { HttpWireTypeName } from '../../src/server/types'
import { type JsonSchema, SchemaBuilder } from './schema-from-types'

const OPENAPI_VERSION = '3.1.0'
const DESCRIPTION_VERSION = '1.0.0'
const DOCUMENT_TITLE = 'Narsil HTTP API'
const DOCUMENT_DESCRIPTION =
  'The HTTP API of a Narsil server. Set the base URL of your client to the address where the server listens.'
const LICENSE = { name: 'Apache-2.0', identifier: 'Apache-2.0' }
const JSON_CONTENT_TYPE = 'application/json'
const WIRE_TYPES_FILE = 'src/server/types/wire.ts'
const WIRE_TYPES_INTERFACE = 'HttpWireTypes'
const ERROR_RESPONSE_REF = '#/components/responses/Error'
const SUCCESS_DESCRIPTION: Readonly<Record<number, string>> = {
  200: 'The server answered the request.',
  201: 'The server created the resource.',
  202: 'The server accepted the work and started a task.',
  503: 'The server cannot take requests now.',
}

interface WireTypes {
  builder: SchemaBuilder
  typeOf: (name: string) => ts.Type
}

function loadWireTypes(packageDirectory: string): WireTypes {
  const configPath = resolve(packageDirectory, 'tsconfig.json')
  const config = ts.getParsedCommandLineOfConfigFile(configPath, undefined, {
    ...ts.sys,
    onUnRecoverableConfigFileDiagnostic: diagnostic => {
      throw new Error(ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'))
    },
  })
  if (config === undefined) throw new Error(`Cannot read ${configPath}`)
  const wirePath = resolve(packageDirectory, WIRE_TYPES_FILE)
  const program = ts.createProgram([wirePath], { ...config.options, noEmit: true })
  const checker = program.getTypeChecker()
  const source = program.getSourceFile(wirePath)
  if (source === undefined) throw new Error(`Cannot read ${wirePath}`)
  const wire = source.statements.find(
    (statement): statement is ts.InterfaceDeclaration =>
      ts.isInterfaceDeclaration(statement) && statement.name.text === WIRE_TYPES_INTERFACE,
  )
  if (wire === undefined) throw new Error(`${wirePath} declares no ${WIRE_TYPES_INTERFACE}`)
  const wireType = checker.getTypeAtLocation(wire)
  const builder = new SchemaBuilder(program, checker, wire)
  const roots = checker
    .getPropertiesOfType(wireType)
    .map(property => ({ name: property.getName(), type: checker.getTypeOfSymbolAtLocation(property, wire) }))
  for (const { name, type } of roots) builder.declareRoot(name, type)
  for (const { name, type } of roots) builder.addRoot(name, type)
  return {
    builder,
    typeOf(name) {
      const property = wireType.getProperty(name)
      if (property === undefined) throw new Error(`${WIRE_TYPES_INTERFACE} holds no ${name}`)
      return checker.getTypeOfSymbolAtLocation(property, wire)
    },
  }
}

function jsonContent(name: string): Record<string, unknown> {
  return { [JSON_CONTENT_TYPE]: { schema: { $ref: `#/components/schemas/${name}` } } }
}

function rawContent(contentType: string): Record<string, unknown> {
  const schema = contentType.startsWith('text/') ? { type: 'string' } : { type: 'string', format: 'binary' }
  return { [contentType]: { schema } }
}

function requestBodyOf(request: RouteRequestBody): Record<string, unknown> | undefined {
  if (request === null) return undefined
  if (typeof request === 'string') return { required: true, content: jsonContent(request) }
  if ('optional' in request) return { required: false, content: jsonContent(request.optional) }
  return { required: true, content: rawContent(request.contentType) }
}

function responseOf(status: number, body: RouteResponseBody): Record<string, unknown> {
  return {
    description: SUCCESS_DESCRIPTION[status] ?? `The server answered with status ${status}.`,
    content: typeof body === 'string' ? jsonContent(body) : rawContent(body.contentType),
  }
}

function openApiPath(path: string): string {
  return path.replace(/:(\w+)/g, '{$1}')
}

function pathParameterDescription(path: string, name: string): string {
  if (name === 'name') return 'The name of the index.'
  return path.startsWith('/tasks') ? 'The id of the task.' : 'The id of the document.'
}

function pathParameters(path: string): JsonSchema[] {
  return [...path.matchAll(/:(\w+)/g)].flatMap(match => {
    const name = match[1]
    if (name === undefined) return []
    return [
      {
        name,
        in: 'path',
        required: true,
        description: pathParameterDescription(path, name),
        schema: { type: 'string' },
      },
    ]
  })
}

function queryParameters(route: RouteSpec, wire: WireTypes): JsonSchema[] {
  if (route.query === undefined) return []
  return wire.builder.propertiesOf(wire.typeOf(route.query), route.query).map(property => {
    const { description, ...schema } = property.schema
    return {
      name: property.name,
      in: 'query',
      required: property.required,
      ...(description === undefined ? {} : { description }),
      ...(schema.type === 'array' ? { style: 'form', explode: false } : {}),
      schema,
    }
  })
}

function operationOf(route: RouteSpec, wire: WireTypes): Record<string, unknown> {
  const parameters = [...pathParameters(route.path), ...queryParameters(route, wire)]
  const requestBody = requestBodyOf(route.request)
  const responses: Record<string, unknown> = {}
  for (const [status, body] of Object.entries(route.responses)) {
    responses[status] = responseOf(Number(status), body)
  }
  responses.default = { $ref: ERROR_RESPONSE_REF }
  return {
    operationId: route.operationId,
    summary: route.summary,
    tags: route.tags,
    ...(route.repeatable === true ? { 'x-narsil-repeatable': true } : {}),
    ...(parameters.length > 0 ? { parameters } : {}),
    ...(requestBody === undefined ? {} : { requestBody }),
    responses,
  }
}

function httpMethod(route: RouteSpec): string {
  return route.method === 'del' ? 'delete' : route.method
}

function assertRoutesDistinct(routes: readonly RouteSpec[]): void {
  const operationIds = new Map<string, RouteSpec>()
  const endpoints = new Set<string>()
  for (const route of routes) {
    const endpoint = `${httpMethod(route).toUpperCase()} ${route.path}`
    if (route.summary.trim().length === 0) throw new Error(`${endpoint} has an empty summary`)
    if (Object.keys(route.responses).length === 0) throw new Error(`${endpoint} describes no response`)
    const shape = endpoint.replace(/:\w+/g, ':')
    if (endpoints.has(shape)) throw new Error(`Two routes share ${endpoint}`)
    endpoints.add(shape)
    const earlier = operationIds.get(route.operationId)
    if (earlier !== undefined) {
      throw new Error(`${endpoint} and ${earlier.path} share the operation ID ${route.operationId}`)
    }
    operationIds.set(route.operationId, route)
  }
}

export function assertEveryRouteDescribed(routes: readonly RouteSpec[], document: unknown): void {
  const paths = (document as { paths?: Record<string, Record<string, unknown>> }).paths ?? {}
  for (const route of routes) {
    if (paths[openApiPath(route.path)]?.[httpMethod(route)] === undefined) {
      throw new Error(`${httpMethod(route).toUpperCase()} ${route.path} is missing from the file`)
    }
  }
}

export function buildOpenApiDocument(routes: readonly RouteSpec[], packageDirectory: string): Record<string, unknown> {
  assertRoutesDistinct(routes)
  const wire = loadWireTypes(packageDirectory)
  const paths: Record<string, Record<string, unknown>> = {}
  for (const route of routes) {
    const path = openApiPath(route.path)
    paths[path] ??= {}
    paths[path][httpMethod(route)] = operationOf(route, wire)
  }
  const tags = [...new Set(routes.flatMap(route => route.tags))].map(name => ({ name }))
  const queryTypes = new Set(routes.map(route => route.query))
  const schemas = Object.fromEntries(
    [...wire.builder.components]
      .filter(([name]) => !queryTypes.has(name as HttpWireTypeName))
      .sort(([a], [b]) => a.localeCompare(b)),
  )
  return {
    openapi: OPENAPI_VERSION,
    info: { title: DOCUMENT_TITLE, version: DESCRIPTION_VERSION, description: DOCUMENT_DESCRIPTION, license: LICENSE },
    tags,
    paths,
    components: {
      schemas,
      responses: {
        Error: {
          description: 'The server refused the request or failed to answer it.',
          content: jsonContent('ErrorEnvelope'),
        },
      },
    },
  }
}
