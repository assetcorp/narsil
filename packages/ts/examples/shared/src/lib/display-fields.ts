const STORAGE_KEY = 'narsil-display-fields'

const TITLE_CANDIDATES = ['title', 'name', 'headline', 'subject', 'label'] as const

const BODY_CANDIDATES = ['body', 'text', 'content', 'description', 'overview', 'abstract', 'summary'] as const

const HEADING_SNIPPET_LENGTH = 80

export interface DisplayFieldMapping {
  titleField: string | null
  bodyField: string | null
}

export interface ResolvedDisplay {
  title: string | null
  titleField: string | null
  body: string
  bodyField: string | null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function fieldText(document: Record<string, unknown>, field: string | null): string {
  if (field === null) return ''
  const value = document[field]
  if (value === null || value === undefined) return ''
  if (Array.isArray(value)) return value.map(entry => String(entry)).join(', ')
  if (typeof value === 'object') return ''
  return String(value)
}

function firstPopulated(document: Record<string, unknown>, candidates: readonly string[]): string | null {
  for (const candidate of candidates) {
    if (fieldText(document, candidate).length > 0) return candidate
  }
  return null
}

export function formatFieldValue(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (Array.isArray(value)) return value.join(', ')
  if (typeof value === 'object') return JSON.stringify(value, null, 2)
  return String(value)
}

export function suggestDisplayFields(fieldNames: readonly string[]): DisplayFieldMapping {
  const available = new Set(fieldNames)
  const titleField = TITLE_CANDIDATES.find(candidate => available.has(candidate)) ?? null
  const bodyField =
    BODY_CANDIDATES.find(candidate => available.has(candidate)) ??
    fieldNames.find(name => name !== titleField) ??
    fieldNames[0] ??
    null
  return { titleField, bodyField }
}

export function resolveDisplay(
  document: Record<string, unknown>,
  mapping: DisplayFieldMapping | null,
  fallbackId: string,
): ResolvedDisplay {
  if (mapping === null) {
    const titleField = firstPopulated(document, TITLE_CANDIDATES)
    const bodyField = firstPopulated(document, BODY_CANDIDATES)
    return {
      title: titleField === null ? fallbackId : fieldText(document, titleField),
      titleField,
      body: fieldText(document, bodyField),
      bodyField,
    }
  }

  const title = fieldText(document, mapping.titleField)
  return {
    title: title.length > 0 ? title : null,
    titleField: mapping.titleField,
    body: fieldText(document, mapping.bodyField),
    bodyField: mapping.bodyField,
  }
}

export function displayHeading(
  document: Record<string, unknown>,
  mapping: DisplayFieldMapping | null,
  fallbackId: string,
): string {
  const resolved = resolveDisplay(document, mapping, fallbackId)
  if (resolved.title !== null) return resolved.title
  if (resolved.body.length > 0) return resolved.body.slice(0, HEADING_SNIPPET_LENGTH)
  return fallbackId
}

function parseMapping(value: unknown): DisplayFieldMapping | null {
  if (!isRecord(value)) return null
  const titleField = typeof value.titleField === 'string' && value.titleField.length > 0 ? value.titleField : null
  const bodyField = typeof value.bodyField === 'string' && value.bodyField.length > 0 ? value.bodyField : null
  if (titleField === null && bodyField === null) return null
  return { titleField, bodyField }
}

function readAllMappings(): Record<string, unknown> {
  if (typeof window === 'undefined') return {}
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (raw === null) return {}
  try {
    const parsed: unknown = JSON.parse(raw)
    return isRecord(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

function writeAllMappings(mappings: Record<string, unknown>): void {
  if (typeof window === 'undefined') return
  if (Object.keys(mappings).length === 0) {
    window.localStorage.removeItem(STORAGE_KEY)
    return
  }
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(mappings))
}

export function readDisplayFields(indexName: string): DisplayFieldMapping | null {
  return parseMapping(readAllMappings()[indexName])
}

export function writeDisplayFields(indexName: string, mapping: DisplayFieldMapping): void {
  const mappings = readAllMappings()
  if (mapping.titleField === null && mapping.bodyField === null) {
    if (!(indexName in mappings)) return
    delete mappings[indexName]
  } else {
    mappings[indexName] = mapping
  }
  writeAllMappings(mappings)
}

export function deleteDisplayFields(indexName: string): void {
  const mappings = readAllMappings()
  if (!(indexName in mappings)) return
  delete mappings[indexName]
  writeAllMappings(mappings)
}
