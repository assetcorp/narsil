import { ErrorCodes, NarsilError } from '../../errors'

export const MAX_DOCUMENT_NESTING_DEPTH = 32

const RESERVED_OBJECT_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

function reject(path: string, reason: string): never {
  throw new NarsilError(ErrorCodes.DOC_VALIDATION_FAILED, `Field "${path === '' ? '(document)' : path}" ${reason}`, {
    field: path,
  })
}

function isPlainObject(value: object): boolean {
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

function walkStorable(value: unknown, path: string, depth: number, ancestors: Set<object>, skip: Set<string>): void {
  if (value === null || value === undefined) return
  const kind = typeof value
  if (kind === 'string' || kind === 'boolean') return
  if (kind === 'number') return
  if (kind === 'bigint' || kind === 'symbol' || kind === 'function') {
    reject(path, `holds a ${kind}, which cannot be stored or recovered`)
  }
  const container = value as object
  if (container instanceof Date || container instanceof Uint8Array) return
  const isArray = Array.isArray(container)
  if (!isArray && !isPlainObject(container)) {
    reject(
      path,
      'holds a value that does not survive storage; use plain objects, arrays, strings, numbers, booleans, dates, or Uint8Array bytes',
    )
  }
  if (depth >= MAX_DOCUMENT_NESTING_DEPTH) {
    reject(path, `nests deeper than ${MAX_DOCUMENT_NESTING_DEPTH} levels`)
  }
  if (ancestors.has(container)) {
    reject(path, 'refers back to one of its own ancestors')
  }
  ancestors.add(container)
  if (isArray) {
    const items = container as unknown[]
    for (let i = 0; i < items.length; i++) {
      walkStorable(items[i], `${path}[${i}]`, depth + 1, ancestors, skip)
    }
  } else {
    const record = container as Record<string, unknown>
    for (const key of Object.keys(record)) {
      const keyPath = path === '' ? key : `${path}.${key}`
      if (RESERVED_OBJECT_KEYS.has(key)) {
        reject(keyPath, 'uses a reserved object key')
      }
      if (skip.has(keyPath)) continue
      walkStorable(record[key], keyPath, depth + 1, ancestors, skip)
    }
  }
  ancestors.delete(container)
}

export function assertStorableDocument(document: Record<string, unknown>, skipFieldPaths?: Set<string>): void {
  walkStorable(document, '', 0, new Set(), skipFieldPaths ?? new Set())
}
