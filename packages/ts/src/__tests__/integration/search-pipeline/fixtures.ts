import type { AnyDocument, IndexConfig, SchemaDefinition } from '../../../types/schema'
import { booksItems, electronicsItems } from './products'
import { clothingItems, homeItems, sportsItems } from './products-extra'

export const schema: SchemaDefinition = {
  title: 'string',
  description: 'string',
  price: 'number',
  inStock: 'boolean',
  category: 'enum',
}

export const indexConfig: IndexConfig = {
  schema,
  language: 'english',
}

export type ProductDoc = AnyDocument & {
  title: string
  description: string
  price: number
  inStock: boolean
  category: string
}

export function generateProducts(): ProductDoc[] {
  const items: ProductDoc[] = [...electronicsItems, ...booksItems, ...clothingItems, ...sportsItems, ...homeItems]

  while (items.length < 200) {
    const base = items[items.length % 75]
    const suffix = Math.floor(items.length / 75) + 1
    items.push({
      ...base,
      title: `${base.title} V${suffix}`,
      price: base.price + suffix * 10,
    })
  }

  return items
}
