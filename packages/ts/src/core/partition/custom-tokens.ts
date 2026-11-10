import type { SchemaField } from '../../schema/validator'
import type { CustomTokenizer } from '../../types/schema'
import { customTokensOf } from '../tokenizer/tokenize'
import { getNestedValue, type PartitionInsertOptions } from './utils'

type CheckedTokens = Array<{ token: string; position: number }>

function checkText(checked: Map<string, CheckedTokens>, tokenizer: CustomTokenizer, text: string): void {
  if (!checked.has(text)) checked.set(text, customTokensOf(tokenizer, text, 'document'))
}

export function withCheckedDocumentTokens(
  document: Record<string, unknown>,
  fields: readonly SchemaField[],
  options: PartitionInsertOptions | undefined,
): PartitionInsertOptions | undefined {
  const tokenizer = options?.customTokenizer
  if (tokenizer === undefined) return options
  const checked = new Map<string, CheckedTokens>()
  for (const field of fields) {
    if (field.base !== 'string' && field.base !== 'string[]') continue
    const value = getNestedValue(document, field.path)
    if (typeof value === 'string') {
      checkText(checked, tokenizer, value)
      continue
    }
    if (!Array.isArray(value)) continue
    for (const item of value) if (typeof item === 'string') checkText(checked, tokenizer, item)
  }
  return { ...options, customTokenizer: { tokenize: text => checked.get(text) ?? tokenizer.tokenize(text) } }
}
