import type { IndexConfig, SchemaDefinition } from '../../../types/schema'
import { booksProducts } from './products-books'
import { clothingProducts } from './products-clothing'
import { electronicsProducts } from './products-electronics'
import { homeProducts } from './products-home'
import { sportsProducts } from './products-sports'

export interface Product {
  title: string
  description: string
  price: number
  inStock: boolean
  category: string
}

export const schema: SchemaDefinition = {
  title: 'string' as const,
  description: 'string' as const,
  price: 'number' as const,
  inStock: 'boolean' as const,
  category: 'enum' as const,
}

export const indexConfig: IndexConfig = {
  schema,
  language: 'english',
}

export const productTemplates: Product[] = [
  ...electronicsProducts,
  ...booksProducts,
  ...clothingProducts,
  ...sportsProducts,
  ...homeProducts,
]

export function generateDocuments(): Product[] {
  const documents: Product[] = []
  for (let i = 0; i < 200; i++) {
    const template = productTemplates[i % productTemplates.length]
    if (i < productTemplates.length) {
      documents.push({ ...template })
    } else {
      documents.push({
        ...template,
        title: `${template.title} V${Math.floor(i / productTemplates.length) + 1}`,
        price: Math.round((template.price + (i % 50)) * 100) / 100,
      })
    }
  }
  return documents
}
