import { createNarsil } from '../dist/index.browser.mjs'

const narsil = await createNarsil()
await narsil.createIndex('products', {
  schema: { title: 'string', category: 'enum', price: 'number' },
})
await narsil.insert('products', { title: 'Trail running shoes', category: 'shoes', price: 120 })
const result = await narsil.query('products', {
  term: 'running',
  filters: { fields: { price: { lt: 200 } } },
  highlight: { fields: ['title'] },
})
console.log(result.hits.length)
