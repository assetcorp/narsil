import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createNarsil, type Narsil } from '../../narsil'
import type { IndexConfig, SchemaDefinition } from '../../types/schema'

const schema: SchemaDefinition = {
  title: 'string',
  description: 'string',
  price: 'number',
  inStock: 'boolean',
  category: 'enum',
}

const indexConfig: IndexConfig = {
  schema,
  language: 'english',
}

const products = [
  {
    title: 'Wireless Headphones',
    description: 'Bluetooth over-ear headphones with noise cancellation',
    price: 149,
    inStock: true,
    category: 'electronics',
  },
  {
    title: 'Running Shoes',
    description: 'Lightweight trail running shoes for off-road terrain',
    price: 89,
    inStock: true,
    category: 'sports',
  },
  {
    title: 'Cotton T-Shirt',
    description: 'Soft cotton crew neck t-shirt for everyday wear',
    price: 25,
    inStock: true,
    category: 'clothing',
  },
  {
    title: 'JavaScript Handbook',
    description: 'The definitive guide to learning JavaScript from scratch',
    price: 45,
    inStock: true,
    category: 'books',
  },
  {
    title: 'Ceramic Vase',
    description: 'Handcrafted ceramic vase for home decoration',
    price: 35,
    inStock: false,
    category: 'home',
  },
  {
    title: 'Wireless Mouse',
    description: 'Ergonomic wireless mouse with adjustable DPI settings',
    price: 39,
    inStock: true,
    category: 'electronics',
  },
  {
    title: 'Yoga Mat',
    description: 'Non-slip yoga mat with carrying strap included',
    price: 29,
    inStock: true,
    category: 'sports',
  },
  {
    title: 'Denim Jacket',
    description: 'Classic denim jacket with button closure and pockets',
    price: 79,
    inStock: true,
    category: 'clothing',
  },
  {
    title: 'Cooking Recipes',
    description: 'A collection of gourmet recipes for home cooks',
    price: 32,
    inStock: true,
    category: 'books',
  },
  {
    title: 'Table Lamp',
    description: 'Adjustable LED table lamp for reading and work desks',
    price: 55,
    inStock: true,
    category: 'home',
  },
  {
    title: 'Wireless Charger',
    description: 'Fast wireless charging pad compatible with all Qi devices',
    price: 29,
    inStock: true,
    category: 'electronics',
  },
  {
    title: 'Basketball',
    description: 'Official size outdoor basketball with textured grip',
    price: 35,
    inStock: false,
    category: 'sports',
  },
  {
    title: 'Winter Coat',
    description: 'Insulated winter coat with waterproof outer shell',
    price: 199,
    inStock: true,
    category: 'clothing',
  },
  {
    title: 'Science Fiction Anthology',
    description: 'Award-winning science fiction short stories',
    price: 18,
    inStock: true,
    category: 'books',
  },
  {
    title: 'Throw Pillow Set',
    description: 'Decorative throw pillows with removable covers',
    price: 42,
    inStock: true,
    category: 'home',
  },
  {
    title: 'Wireless Keyboard',
    description: 'Slim wireless keyboard with backlit keys',
    price: 69,
    inStock: true,
    category: 'electronics',
  },
  {
    title: 'Tennis Racket',
    description: 'Graphite tennis racket for intermediate players',
    price: 120,
    inStock: true,
    category: 'sports',
  },
  {
    title: 'Silk Scarf',
    description: 'Handmade silk scarf with floral print pattern',
    price: 55,
    inStock: true,
    category: 'clothing',
  },
  {
    title: 'History of Art',
    description: 'Visual history of art movements across centuries',
    price: 65,
    inStock: false,
    category: 'books',
  },
  {
    title: 'Scented Candle',
    description: 'Soy wax scented candle with vanilla and lavender',
    price: 22,
    inStock: true,
    category: 'home',
  },
  {
    title: 'Wireless Earbuds',
    description: 'True wireless earbuds with active noise cancellation',
    price: 129,
    inStock: true,
    category: 'electronics',
  },
  {
    title: 'Hiking Backpack',
    description: 'Durable hiking backpack with hydration bladder pocket',
    price: 95,
    inStock: true,
    category: 'sports',
  },
  {
    title: 'Linen Pants',
    description: 'Breathable linen pants for warm weather comfort',
    price: 65,
    inStock: true,
    category: 'clothing',
  },
  {
    title: 'Poetry Collection',
    description: 'Contemporary poetry from emerging voices worldwide',
    price: 16,
    inStock: true,
    category: 'books',
  },
  {
    title: 'Wall Clock',
    description: 'Minimalist wall clock with silent movement mechanism',
    price: 48,
    inStock: true,
    category: 'home',
  },
  {
    title: 'Portable Speaker',
    description: 'Waterproof portable Bluetooth speaker for outdoor use',
    price: 79,
    inStock: true,
    category: 'electronics',
  },
  {
    title: 'Swimming Goggles',
    description: 'Anti-fog swimming goggles with UV protection lenses',
    price: 24,
    inStock: true,
    category: 'sports',
  },
  {
    title: 'Wool Sweater',
    description: 'Merino wool pullover sweater for cold seasons',
    price: 110,
    inStock: false,
    category: 'clothing',
  },
  {
    title: 'Gardening Guide',
    description: 'Step-by-step gardening guide for beginners',
    price: 22,
    inStock: true,
    category: 'books',
  },
  {
    title: 'Doormat',
    description: 'Weather-resistant coir doormat for front entrance',
    price: 28,
    inStock: true,
    category: 'home',
  },
  {
    title: 'USB-C Hub',
    description: 'Multi-port USB-C hub with HDMI and ethernet',
    price: 59,
    inStock: true,
    category: 'electronics',
  },
  {
    title: 'Jump Rope',
    description: 'Adjustable speed jump rope for cardio training',
    price: 15,
    inStock: true,
    category: 'sports',
  },
  {
    title: 'Leather Belt',
    description: 'Genuine leather belt with brushed nickel buckle',
    price: 45,
    inStock: true,
    category: 'clothing',
  },
  {
    title: 'Travel Memoir',
    description: 'Captivating travel stories from Southeast Asia',
    price: 19,
    inStock: true,
    category: 'books',
  },
  {
    title: 'Picture Frame',
    description: 'Wooden picture frame for standard photo sizes',
    price: 18,
    inStock: true,
    category: 'home',
  },
  {
    title: 'Webcam HD',
    description: 'High-definition webcam with built-in microphone',
    price: 89,
    inStock: true,
    category: 'electronics',
  },
  {
    title: 'Resistance Bands',
    description: 'Set of five resistance bands for strength training',
    price: 20,
    inStock: true,
    category: 'sports',
  },
  {
    title: 'Rain Boots',
    description: 'Waterproof rubber rain boots with traction sole',
    price: 58,
    inStock: true,
    category: 'clothing',
  },
  {
    title: 'Thriller Novel',
    description: 'Page-turning thriller novel by bestselling author',
    price: 14,
    inStock: true,
    category: 'books',
  },
  {
    title: 'Bath Towel Set',
    description: 'Plush cotton bath towel set in assorted colors',
    price: 38,
    inStock: true,
    category: 'home',
  },
  {
    title: 'Wireless Router',
    description: 'Dual-band wireless router with parental controls',
    price: 109,
    inStock: true,
    category: 'electronics',
  },
  {
    title: 'Dumbbells Set',
    description: 'Adjustable dumbbells set for home gym workouts',
    price: 150,
    inStock: true,
    category: 'sports',
  },
  {
    title: 'Polo Shirt',
    description: 'Classic polo shirt in pique cotton fabric',
    price: 40,
    inStock: true,
    category: 'clothing',
  },
  {
    title: 'Biographies Bundle',
    description: 'Collection of biographies of world-changing leaders',
    price: 38,
    inStock: true,
    category: 'books',
  },
  {
    title: 'Coaster Set',
    description: 'Cork coaster set with artistic prints for tables',
    price: 15,
    inStock: true,
    category: 'home',
  },
  {
    title: 'Monitor Stand',
    description: 'Adjustable monitor stand with cable management',
    price: 45,
    inStock: true,
    category: 'electronics',
  },
  {
    title: 'Soccer Ball',
    description: 'Match-quality soccer ball for grass and turf play',
    price: 30,
    inStock: true,
    category: 'sports',
  },
  {
    title: 'Flannel Shirt',
    description: 'Soft flannel button-down shirt in plaid pattern',
    price: 35,
    inStock: true,
    category: 'clothing',
  },
  {
    title: 'Philosophy Intro',
    description: 'Introduction to philosophy for curious minds',
    price: 27,
    inStock: false,
    category: 'books',
  },
  {
    title: 'Bookshelf Organizer',
    description: 'Stackable bookshelf organizer with adjustable dividers',
    price: 33,
    inStock: true,
    category: 'home',
  },
]

describe('Index Lifecycle Integration', () => {
  let narsil: Narsil

  beforeEach(async () => {
    narsil = await createNarsil()
  })

  afterEach(async () => {
    await narsil.shutdown()
  })

  it('creates an index, populates it, queries, updates, removes, drops, and shuts down', async () => {
    await narsil.createIndex('products', indexConfig)

    const indexes = narsil.listIndexes()
    expect(indexes.length).toBe(1)
    expect(indexes[0].name).toBe('products')

    const insertedIds: string[] = []
    for (const product of products) {
      const id = await narsil.insert('products', product)
      insertedIds.push(id)
    }

    const count = await narsil.countDocuments('products')
    expect(count).toBe(50)

    const wirelessResults = await narsil.query('products', { term: 'wireless' })
    expect(wirelessResults.hits.length).toBeGreaterThan(0)
    expect(wirelessResults.count).toBeGreaterThan(0)

    const wirelessDocTitles = wirelessResults.hits.map(h => (h.document as Record<string, unknown>).title as string)
    const hasWirelessMatch = wirelessDocTitles.some(t => t.toLowerCase().includes('wireless'))
    expect(hasWirelessMatch).toBe(true)

    const idsToUpdate = insertedIds.slice(0, 5)
    const newPrices = [999, 888, 777, 666, 555]

    for (let i = 0; i < idsToUpdate.length; i++) {
      const currentDoc = await narsil.get('products', idsToUpdate[i])
      expect(currentDoc).toBeDefined()
      await narsil.update('products', idsToUpdate[i], {
        ...currentDoc,
        price: newPrices[i],
      })
    }

    for (let i = 0; i < idsToUpdate.length; i++) {
      const updatedDoc = await narsil.get('products', idsToUpdate[i])
      expect(updatedDoc).toBeDefined()
      expect(updatedDoc?.price).toBe(newPrices[i])
    }

    const idsToRemove = insertedIds.slice(5, 10)
    for (const id of idsToRemove) {
      await narsil.remove('products', id)
    }

    const countAfterRemoval = await narsil.countDocuments('products')
    expect(countAfterRemoval).toBe(45)

    for (const id of idsToRemove) {
      const removed = await narsil.get('products', id)
      expect(removed).toBeUndefined()
    }

    const hasResult = await narsil.has('products', idsToRemove[0])
    expect(hasResult).toBe(false)

    const stillExists = await narsil.has('products', insertedIds[0])
    expect(stillExists).toBe(true)

    await narsil.dropIndex('products')

    const indexesAfterDrop = narsil.listIndexes()
    expect(indexesAfterDrop.length).toBe(0)

    await narsil.shutdown()
  })

  it('handles batch insert, update, and remove operations', async () => {
    await narsil.createIndex('products', indexConfig)

    const batchResult = await narsil.insertBatch('products', products.slice(0, 20))
    expect(batchResult.succeeded.length).toBe(20)
    expect(batchResult.failed.length).toBe(0)

    const count = await narsil.countDocuments('products')
    expect(count).toBe(20)

    const updateBatchResult = await narsil.updateBatch('products', [
      { docId: batchResult.succeeded[0], document: { ...products[0], price: 999 } },
      { docId: batchResult.succeeded[1], document: { ...products[1], price: 888 } },
    ])
    expect(updateBatchResult.succeeded.length).toBe(2)
    expect(updateBatchResult.failed.length).toBe(0)

    const updated = await narsil.get('products', batchResult.succeeded[0])
    expect(updated?.price).toBe(999)

    const removeBatchResult = await narsil.removeBatch('products', batchResult.succeeded.slice(0, 5))
    expect(removeBatchResult.succeeded.length).toBe(5)
    expect(removeBatchResult.failed.length).toBe(0)

    const countAfterRemoval = await narsil.countDocuments('products')
    expect(countAfterRemoval).toBe(15)
  })

  it('supports multiple indexes existing simultaneously', async () => {
    await narsil.createIndex('products', indexConfig)
    await narsil.createIndex('articles', {
      schema: { title: 'string', body: 'string', published: 'boolean' },
      language: 'english',
    })

    const indexes = narsil.listIndexes()
    expect(indexes.length).toBe(2)
    expect(indexes.map(i => i.name).sort()).toEqual(['articles', 'products'])

    await narsil.insert('products', products[0])
    await narsil.insert('articles', {
      title: 'Wireless Technology Advances',
      body: 'The latest in wireless communication and devices',
      published: true,
    })

    const productResults = await narsil.query('products', { term: 'wireless' })
    const articleResults = await narsil.query('articles', { term: 'wireless' })

    expect(productResults.hits.length).toBeGreaterThan(0)
    expect(articleResults.hits.length).toBeGreaterThan(0)

    await narsil.dropIndex('products')
    const remaining = narsil.listIndexes()
    expect(remaining.length).toBe(1)
    expect(remaining[0].name).toBe('articles')
  })

  it('reports correct stats for an index', async () => {
    await narsil.createIndex('products', indexConfig)

    for (const product of products.slice(0, 10)) {
      await narsil.insert('products', product)
    }

    const stats = narsil.getStats('products')
    expect(stats.documentCount).toBe(10)
    expect(stats.partitionCount).toBeGreaterThanOrEqual(1)
    expect(stats.language).toBe('english')
    expect(stats.schema).toEqual(schema)
  })
})
