import { DOCUMENT_SPLIT, QUERY_SPLIT } from './constants'

const ROW_DIGITS = 5

export function documentIdOf(row: number): string {
  return `${DOCUMENT_SPLIT}-${String(row).padStart(ROW_DIGITS, '0')}`
}

export function queryIdOf(row: number): string {
  return `${QUERY_SPLIT}-${String(row).padStart(ROW_DIGITS, '0')}`
}
