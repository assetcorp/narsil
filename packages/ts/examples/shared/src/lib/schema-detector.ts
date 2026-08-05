const RESERVED_ROOT_FIELDS = new Set(['id'])

const PROTOTYPE_POLLUTION_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

const FIELD_NAME_PATTERN = /^[A-Za-z0-9_]+$/

export interface DetectedField {
  name: string
  detectedType: string
  overrideType: string | null
  searchable: boolean
}

export function isDocumentIdField(name: string): boolean {
  return RESERVED_ROOT_FIELDS.has(name)
}

export function fieldNameError(name: string): string | null {
  if (isDocumentIdField(name)) return null
  if (PROTOTYPE_POLLUTION_KEYS.has(name)) return `"${name}" is not allowed as a field name`
  if (!FIELD_NAME_PATTERN.test(name)) return `"${name}" must use letters, digits, and underscores only`
  return null
}

export function detectSchema(documents: Record<string, unknown>[], sampleSize = 100): DetectedField[] {
  const sample = documents.slice(0, sampleSize)
  const fieldTypes = new Map<string, Set<string>>()
  const fieldArrayTypes = new Map<string, Set<string>>()
  const fieldValueCounts = new Map<string, Set<string>>()

  for (const doc of sample) {
    for (const [key, value] of Object.entries(doc)) {
      if (value === null || value === undefined) continue

      if (!fieldTypes.has(key)) {
        fieldTypes.set(key, new Set())
        fieldArrayTypes.set(key, new Set())
        fieldValueCounts.set(key, new Set())
      }

      const types = fieldTypes.get(key)
      if (!types) continue

      const arrTypes = fieldArrayTypes.get(key)

      if (Array.isArray(value)) {
        types.add('array')
        if (arrTypes) {
          for (const item of value) {
            arrTypes.add(typeof item)
          }
        }
      } else {
        types.add(typeof value)
      }

      if (typeof value === 'string') {
        const values = fieldValueCounts.get(key)
        if (values && values.size < 50) values.add(value)
      }
    }
  }

  const fields: DetectedField[] = []

  for (const [name, types] of fieldTypes.entries()) {
    let detectedType = 'string'
    const isSearchable = types.has('string')

    if (types.has('array')) {
      const arrayItemTypes = fieldArrayTypes.get(name)
      if (arrayItemTypes?.has('string')) {
        detectedType = 'string[]'
      } else if (arrayItemTypes?.has('number')) {
        detectedType = 'number[]'
      } else {
        detectedType = 'string[]'
      }
    } else if (types.has('boolean') && types.size === 1) {
      detectedType = 'boolean'
    } else if (types.has('number') && !types.has('string')) {
      detectedType = 'number'
    } else if (types.has('string')) {
      const uniqueValues = fieldValueCounts.get(name)
      if (uniqueValues && uniqueValues.size < 20 && sample.length >= 10) {
        detectedType = 'enum'
      } else {
        detectedType = 'string'
      }
    }

    fields.push({
      name,
      detectedType,
      overrideType: null,
      searchable: isSearchable || detectedType === 'string' || detectedType === 'string[]',
    })
  }

  return fields
}

export function buildSchema(fields: DetectedField[]): Record<string, string> {
  const schema: Record<string, string> = {}
  for (const field of fields) {
    if (isDocumentIdField(field.name)) continue
    schema[field.name] = field.overrideType ?? field.detectedType
  }
  return schema
}
