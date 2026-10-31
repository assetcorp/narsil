import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { Ajv2020, type ValidateFunction } from 'ajv/dist/2020'

export interface OpenApiMedia {
  schema: Record<string, unknown>
}

export interface OpenApiResponse {
  description: string
  content?: Record<string, OpenApiMedia>
  $ref?: string
}

export interface OpenApiOperation {
  operationId: string
  summary: string
  tags: string[]
  'x-narsil-repeatable'?: boolean
  parameters?: Array<{ name: string; in: string; required: boolean; schema: Record<string, unknown> }>
  requestBody?: { required: boolean; content: Record<string, OpenApiMedia> }
  responses: Record<string, OpenApiResponse>
}

export interface OpenApiDocument {
  openapi: string
  paths: Record<string, Record<string, OpenApiOperation>>
  components: {
    schemas: Record<string, Record<string, unknown>>
    responses: Record<string, OpenApiResponse>
  }
}

export interface LocatedOperation {
  method: string
  path: string
  operation: OpenApiOperation
}

export interface ReceivedResponse {
  status: number
  contentType: string | null
  bytes: Uint8Array
  text: string
}

const SCHEMA_ID = 'https://narsil.test/openapi.json'
const JSON_CONTENT_TYPE = 'application/json'

export function publishedFilePath(): string {
  return createRequire(import.meta.url).resolve('@delali/narsil/openapi.json')
}

export function loadPublishedFile(): OpenApiDocument {
  return JSON.parse(readFileSync(publishedFilePath(), 'utf-8')) as OpenApiDocument
}

export function operationsOf(document: OpenApiDocument): LocatedOperation[] {
  return Object.entries(document.paths).flatMap(([path, methods]) =>
    Object.entries(methods).map(([method, operation]) => ({ method, path, operation })),
  )
}

function refuseUndescribedFields(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(refuseUndescribedFields)
  if (node === null || typeof node !== 'object') return node
  const copy: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(node)) copy[key] = refuseUndescribedFields(value)
  if (copy.type === 'object' && copy.additionalProperties === undefined) copy.additionalProperties = false
  return copy
}

export class ContractChecker {
  private readonly ajv = new Ajv2020({ strict: false, allErrors: true, validateFormats: false })
  private readonly compiled = new Map<string, ValidateFunction>()

  constructor(private readonly document: OpenApiDocument) {
    this.ajv.addSchema({
      $id: SCHEMA_ID,
      components: { schemas: refuseUndescribedFields(document.components.schemas) },
    })
  }

  checkRequestBody(operation: OpenApiOperation, body: unknown): void {
    const schema = operation.requestBody?.content[JSON_CONTENT_TYPE]?.schema
    if (schema === undefined) throw new Error(`${operation.operationId} takes no JSON body in the file`)
    this.assertMatches(schema, body, `the request body of ${operation.operationId}`)
  }

  checkResponse(operation: OpenApiOperation, response: ReceivedResponse): void {
    const label = `${operation.operationId} answering ${response.status}`
    const listed = operation.responses[String(response.status)]
    if (listed === undefined && response.status < 400) {
      throw new Error(`${label} is a success status that the file leaves out`)
    }
    const described = this.resolve(listed ?? operation.responses.default, label)
    const [contentType, media] = Object.entries(described.content ?? {})[0] ?? []
    if (contentType === undefined || media === undefined) throw new Error(`${label} has no content in the file`)
    if (response.contentType !== contentType) {
      throw new Error(`${label} sent the content type ${response.contentType}, but the file says ${contentType}`)
    }
    if (contentType !== JSON_CONTENT_TYPE) return
    this.assertMatches(media.schema, JSON.parse(response.text), label)
  }

  private resolve(response: OpenApiResponse | undefined, label: string): OpenApiResponse {
    if (response === undefined) throw new Error(`${label} has no description in the file`)
    if (response.$ref === undefined) return response
    const name = response.$ref.split('/').pop() ?? ''
    const target = this.document.components.responses[name]
    if (target === undefined) throw new Error(`${label} refers to the missing response ${response.$ref}`)
    return target
  }

  private assertMatches(schema: Record<string, unknown>, value: unknown, label: string): void {
    const validate = this.validatorFor(schema)
    if (validate(value)) return
    const errors = this.ajv.errorsText(validate.errors, { separator: '\n  ', dataVar: 'body' })
    throw new Error(`${label} breaks the file:\n  ${errors}\nThe body was ${JSON.stringify(value).slice(0, 2000)}`)
  }

  private validatorFor(schema: Record<string, unknown>): ValidateFunction {
    const ref = String(schema.$ref)
    const known = this.compiled.get(ref)
    if (known !== undefined) return known
    const validate = this.ajv.compile({ $ref: `${SCHEMA_ID}${ref}` })
    this.compiled.set(ref, validate)
    return validate
  }
}
