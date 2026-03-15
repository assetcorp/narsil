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

interface ProductDoc {
  title: string
  description: string
  price: number
  inStock: boolean
  category: string
}

function generateProducts(): ProductDoc[] {
  const items: ProductDoc[] = [
    {
      title: 'Wireless Headphones',
      description: 'Bluetooth over-ear headphones with noise cancellation and long battery life',
      price: 149,
      inStock: true,
      category: 'electronics',
    },
    {
      title: 'Wireless Mouse',
      description: 'Ergonomic wireless mouse with adjustable DPI settings and silent clicks',
      price: 39,
      inStock: true,
      category: 'electronics',
    },
    {
      title: 'Wireless Keyboard',
      description: 'Slim wireless keyboard with backlit keys for comfortable typing',
      price: 69,
      inStock: true,
      category: 'electronics',
    },
    {
      title: 'Wireless Charger',
      description: 'Fast wireless charging pad compatible with all Qi enabled devices',
      price: 29,
      inStock: true,
      category: 'electronics',
    },
    {
      title: 'Wireless Earbuds',
      description: 'True wireless earbuds with active noise cancellation technology',
      price: 129,
      inStock: true,
      category: 'electronics',
    },
    {
      title: 'Portable Speaker',
      description: 'Waterproof portable Bluetooth speaker for outdoor adventures',
      price: 79,
      inStock: true,
      category: 'electronics',
    },
    {
      title: 'USB-C Hub',
      description: 'Multi-port USB-C hub with HDMI output and ethernet connectivity',
      price: 59,
      inStock: false,
      category: 'electronics',
    },
    {
      title: 'Webcam HD',
      description: 'High-definition webcam with built-in microphone for video calls',
      price: 89,
      inStock: true,
      category: 'electronics',
    },
    {
      title: 'Wireless Router',
      description: 'Dual-band wireless router with parental controls and guest network',
      price: 109,
      inStock: true,
      category: 'electronics',
    },
    {
      title: 'Monitor Stand',
      description: 'Adjustable monitor stand with cable management and storage drawer',
      price: 45,
      inStock: true,
      category: 'electronics',
    },
    {
      title: 'Mechanical Keyboard',
      description: 'Cherry MX mechanical keyboard with RGB lighting effects',
      price: 159,
      inStock: true,
      category: 'electronics',
    },
    {
      title: 'Gaming Mouse',
      description: 'High-precision gaming mouse with programmable macro buttons',
      price: 75,
      inStock: true,
      category: 'electronics',
    },
    {
      title: 'Noise Cancelling Headset',
      description: 'Over-ear noise cancelling headset for professional meetings',
      price: 199,
      inStock: true,
      category: 'electronics',
    },
    {
      title: 'Laptop Cooling Pad',
      description: 'Slim laptop cooling pad with dual fans and adjustable height',
      price: 35,
      inStock: true,
      category: 'electronics',
    },
    {
      title: 'External SSD',
      description: 'Portable external SSD with 1TB storage and fast transfer speeds',
      price: 119,
      inStock: false,
      category: 'electronics',
    },

    {
      title: 'JavaScript Handbook',
      description: 'The definitive guide to learning JavaScript from fundamentals to advanced',
      price: 45,
      inStock: true,
      category: 'books',
    },
    {
      title: 'Cooking Recipes',
      description: 'A collection of gourmet recipes for home cooks and food enthusiasts',
      price: 32,
      inStock: true,
      category: 'books',
    },
    {
      title: 'Science Fiction Anthology',
      description: 'Award-winning science fiction short stories from visionary authors',
      price: 18,
      inStock: true,
      category: 'books',
    },
    {
      title: 'History of Art',
      description: 'Visual history of art movements across centuries and civilizations',
      price: 65,
      inStock: false,
      category: 'books',
    },
    {
      title: 'Poetry Collection',
      description: 'Contemporary poetry from emerging voices around the globe',
      price: 16,
      inStock: true,
      category: 'books',
    },
    {
      title: 'Gardening Guide',
      description: 'Step-by-step gardening guide for beginners who want green thumbs',
      price: 22,
      inStock: true,
      category: 'books',
    },
    {
      title: 'Travel Memoir',
      description: 'Captivating travel stories from Southeast Asia and the Pacific',
      price: 19,
      inStock: true,
      category: 'books',
    },
    {
      title: 'Thriller Novel',
      description: 'Page-turning thriller novel by a bestselling mystery author',
      price: 14,
      inStock: true,
      category: 'books',
    },
    {
      title: 'Biographies Bundle',
      description: 'Collection of biographies of world-changing leaders and innovators',
      price: 38,
      inStock: true,
      category: 'books',
    },
    {
      title: 'Philosophy Intro',
      description: 'Introduction to philosophy for curious minds and critical thinkers',
      price: 27,
      inStock: false,
      category: 'books',
    },
    {
      title: 'Machine Learning Primer',
      description: 'Hands-on introduction to machine learning algorithms and applications',
      price: 52,
      inStock: true,
      category: 'books',
    },
    {
      title: 'Creative Writing Workshop',
      description: 'Practical exercises for developing your creative writing skills',
      price: 24,
      inStock: true,
      category: 'books',
    },
    {
      title: 'World History Atlas',
      description: 'Illustrated atlas covering world history from ancient to present',
      price: 48,
      inStock: true,
      category: 'books',
    },
    {
      title: 'Psychology Basics',
      description: 'Foundations of psychology for students and lifelong learners',
      price: 33,
      inStock: true,
      category: 'books',
    },
    {
      title: 'Economics Explained',
      description: 'Clear explanations of economic principles and market behavior',
      price: 29,
      inStock: true,
      category: 'books',
    },

    {
      title: 'Cotton T-Shirt',
      description: 'Soft cotton crew neck t-shirt for everyday casual wear',
      price: 25,
      inStock: true,
      category: 'clothing',
    },
    {
      title: 'Denim Jacket',
      description: 'Classic denim jacket with button closure and front pockets',
      price: 79,
      inStock: true,
      category: 'clothing',
    },
    {
      title: 'Winter Coat',
      description: 'Insulated winter coat with waterproof outer shell and hood',
      price: 199,
      inStock: true,
      category: 'clothing',
    },
    {
      title: 'Silk Scarf',
      description: 'Handmade silk scarf with floral print and fringed edges',
      price: 55,
      inStock: true,
      category: 'clothing',
    },
    {
      title: 'Linen Pants',
      description: 'Breathable linen pants for warm weather comfort and style',
      price: 65,
      inStock: true,
      category: 'clothing',
    },
    {
      title: 'Wool Sweater',
      description: 'Merino wool pullover sweater for cold season layering',
      price: 110,
      inStock: false,
      category: 'clothing',
    },
    {
      title: 'Leather Belt',
      description: 'Genuine leather belt with brushed nickel buckle and stitching',
      price: 45,
      inStock: true,
      category: 'clothing',
    },
    {
      title: 'Rain Boots',
      description: 'Waterproof rubber rain boots with traction sole for wet days',
      price: 58,
      inStock: true,
      category: 'clothing',
    },
    {
      title: 'Polo Shirt',
      description: 'Classic polo shirt in pique cotton fabric for smart casual looks',
      price: 40,
      inStock: true,
      category: 'clothing',
    },
    {
      title: 'Flannel Shirt',
      description: 'Soft flannel button-down shirt in plaid pattern for autumn',
      price: 35,
      inStock: true,
      category: 'clothing',
    },
    {
      title: 'Running Shorts',
      description: 'Lightweight running shorts with moisture-wicking fabric',
      price: 30,
      inStock: true,
      category: 'clothing',
    },
    {
      title: 'Cashmere Cardigan',
      description: 'Luxurious cashmere cardigan with mother-of-pearl buttons',
      price: 189,
      inStock: true,
      category: 'clothing',
    },
    {
      title: 'Cargo Pants',
      description: 'Durable cargo pants with multiple pockets for utility',
      price: 55,
      inStock: true,
      category: 'clothing',
    },
    {
      title: 'Sundress',
      description: 'Flowing sundress with adjustable straps and floral print',
      price: 48,
      inStock: true,
      category: 'clothing',
    },
    {
      title: 'Athletic Socks Pack',
      description: 'Six-pack of cushioned athletic socks for daily training',
      price: 18,
      inStock: true,
      category: 'clothing',
    },

    {
      title: 'Running Shoes',
      description: 'Lightweight trail running shoes for off-road terrain and endurance',
      price: 89,
      inStock: true,
      category: 'sports',
    },
    {
      title: 'Yoga Mat',
      description: 'Non-slip yoga mat with carrying strap for studio and home',
      price: 29,
      inStock: true,
      category: 'sports',
    },
    {
      title: 'Basketball',
      description: 'Official size outdoor basketball with textured grip surface',
      price: 35,
      inStock: false,
      category: 'sports',
    },
    {
      title: 'Tennis Racket',
      description: 'Graphite tennis racket for intermediate and advanced players',
      price: 120,
      inStock: true,
      category: 'sports',
    },
    {
      title: 'Hiking Backpack',
      description: 'Durable hiking backpack with hydration bladder pocket included',
      price: 95,
      inStock: true,
      category: 'sports',
    },
    {
      title: 'Swimming Goggles',
      description: 'Anti-fog swimming goggles with UV protection and comfort fit',
      price: 24,
      inStock: true,
      category: 'sports',
    },
    {
      title: 'Jump Rope',
      description: 'Adjustable speed jump rope for cardio training at any level',
      price: 15,
      inStock: true,
      category: 'sports',
    },
    {
      title: 'Dumbbells Set',
      description: 'Adjustable dumbbells set for home gym strength workouts',
      price: 150,
      inStock: true,
      category: 'sports',
    },
    {
      title: 'Soccer Ball',
      description: 'Match-quality soccer ball for grass and turf playing surfaces',
      price: 30,
      inStock: true,
      category: 'sports',
    },
    {
      title: 'Resistance Bands',
      description: 'Set of five resistance bands for strength and flexibility training',
      price: 20,
      inStock: true,
      category: 'sports',
    },
    {
      title: 'Cycling Helmet',
      description: 'Aerodynamic cycling helmet with ventilation and visor',
      price: 65,
      inStock: true,
      category: 'sports',
    },
    {
      title: 'Boxing Gloves',
      description: 'Professional boxing gloves with wrist support padding',
      price: 55,
      inStock: true,
      category: 'sports',
    },
    {
      title: 'Foam Roller',
      description: 'High-density foam roller for muscle recovery and stretching',
      price: 25,
      inStock: true,
      category: 'sports',
    },
    {
      title: 'Badminton Set',
      description: 'Complete badminton set with rackets, shuttlecocks, and net',
      price: 42,
      inStock: true,
      category: 'sports',
    },
    {
      title: 'Fishing Rod',
      description: 'Telescopic fishing rod with spinning reel for freshwater',
      price: 75,
      inStock: false,
      category: 'sports',
    },

    {
      title: 'Ceramic Vase',
      description: 'Handcrafted ceramic vase for home decoration and flower displays',
      price: 35,
      inStock: false,
      category: 'home',
    },
    {
      title: 'Table Lamp',
      description: 'Adjustable LED table lamp for reading and productive work sessions',
      price: 55,
      inStock: true,
      category: 'home',
    },
    {
      title: 'Throw Pillow Set',
      description: 'Decorative throw pillows with removable washable covers',
      price: 42,
      inStock: true,
      category: 'home',
    },
    {
      title: 'Scented Candle',
      description: 'Soy wax scented candle with vanilla and lavender fragrance',
      price: 22,
      inStock: true,
      category: 'home',
    },
    {
      title: 'Wall Clock',
      description: 'Minimalist wall clock with silent movement for quiet rooms',
      price: 48,
      inStock: true,
      category: 'home',
    },
    {
      title: 'Doormat',
      description: 'Weather-resistant coir doormat for front entrance welcome',
      price: 28,
      inStock: true,
      category: 'home',
    },
    {
      title: 'Picture Frame',
      description: 'Wooden picture frame for standard photo sizes and art prints',
      price: 18,
      inStock: true,
      category: 'home',
    },
    {
      title: 'Bath Towel Set',
      description: 'Plush cotton bath towel set in assorted colors for bathroom',
      price: 38,
      inStock: true,
      category: 'home',
    },
    {
      title: 'Coaster Set',
      description: 'Cork coaster set with artistic prints for coffee tables',
      price: 15,
      inStock: true,
      category: 'home',
    },
    {
      title: 'Bookshelf Organizer',
      description: 'Stackable bookshelf organizer with adjustable dividers',
      price: 33,
      inStock: true,
      category: 'home',
    },
    {
      title: 'Kitchen Timer',
      description: 'Digital kitchen timer with magnetic back and loud alarm',
      price: 12,
      inStock: true,
      category: 'home',
    },
    {
      title: 'Storage Baskets',
      description: 'Woven storage baskets for closet and shelf organization',
      price: 26,
      inStock: true,
      category: 'home',
    },
    {
      title: 'Plant Pot Set',
      description: 'Set of three ceramic plant pots with drainage holes',
      price: 30,
      inStock: true,
      category: 'home',
    },
    {
      title: 'Shower Curtain',
      description: 'Waterproof polyester shower curtain with minimalist design',
      price: 20,
      inStock: true,
      category: 'home',
    },
    {
      title: 'Cutting Board',
      description: 'Bamboo cutting board with juice groove and handle',
      price: 24,
      inStock: true,
      category: 'home',
    },
  ]

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

describe('Search Pipeline Integration', () => {
  let narsil: Narsil
  let docIds: string[]
  const allProducts = generateProducts()

  beforeEach(async () => {
    narsil = await createNarsil()
    await narsil.createIndex('products', indexConfig)

    docIds = []
    for (const product of allProducts) {
      const id = await narsil.insert('products', product)
      docIds.push(id)
    }

    const count = await narsil.countDocuments('products')
    expect(count).toBe(200)
  })

  afterEach(async () => {
    await narsil.shutdown()
  })

  describe('individual search features', () => {
    it('returns results for a fulltext search term', async () => {
      const result = await narsil.query<ProductDoc>('products', { term: 'wireless' })

      expect(result.hits.length).toBeGreaterThan(0)
      expect(result.count).toBeGreaterThan(0)
      expect(result.elapsed).toBeGreaterThanOrEqual(0)

      for (const hit of result.hits) {
        expect(hit.id).toBeTruthy()
        expect(hit.score).toBeGreaterThan(0)
        expect(hit.document).toBeDefined()
      }
    })

    it('applies numeric range filters on price', async () => {
      const result = await narsil.query<ProductDoc>('products', {
        term: 'wireless',
        filters: {
          fields: {
            price: { gte: 50, lte: 150 },
          },
        },
      })

      expect(result.hits.length).toBeGreaterThan(0)
      for (const hit of result.hits) {
        expect(hit.document.price).toBeGreaterThanOrEqual(50)
        expect(hit.document.price).toBeLessThanOrEqual(150)
      }
    })

    it('applies enum filters on category', async () => {
      const result = await narsil.query<ProductDoc>('products', {
        term: 'wireless',
        filters: {
          fields: {
            category: { eq: 'electronics' },
          },
        },
      })

      expect(result.hits.length).toBeGreaterThan(0)
      for (const hit of result.hits) {
        expect(hit.document.category).toBe('electronics')
      }
    })

    it('applies boolean filters on inStock', async () => {
      const result = await narsil.query<ProductDoc>('products', {
        term: 'swimming goggles',
        filters: {
          fields: {
            inStock: { eq: true },
          },
        },
      })

      for (const hit of result.hits) {
        expect(hit.document.inStock).toBe(true)
      }
    })

    it('returns facets on the category field', async () => {
      const result = await narsil.query<ProductDoc>('products', {
        term: 'wireless',
        facets: {
          category: {},
        },
      })

      expect(result.facets).toBeDefined()
      expect(result.facets?.category).toBeDefined()
      expect(result.facets?.category.values).toBeDefined()

      const facetValues = result.facets?.category.values
      expect(Object.keys(facetValues).length).toBeGreaterThan(0)
    })

    it('sorts results by price ascending', async () => {
      const result = await narsil.query<ProductDoc>('products', {
        term: 'shoes',
        sort: { price: 'asc' },
      })

      expect(result.hits.length).toBeGreaterThan(0)
      const prices = result.hits.map(h => h.document.price)
      for (let i = 1; i < prices.length; i++) {
        expect(prices[i]).toBeGreaterThanOrEqual(prices[i - 1])
      }
    })

    it('sorts results by price descending', async () => {
      const result = await narsil.query<ProductDoc>('products', {
        term: 'shoes',
        sort: { price: 'desc' },
      })

      expect(result.hits.length).toBeGreaterThan(0)
      const prices = result.hits.map(h => h.document.price)
      for (let i = 1; i < prices.length; i++) {
        expect(prices[i]).toBeLessThanOrEqual(prices[i - 1])
      }
    })

    it('sorts results by a string field', async () => {
      const result = await narsil.query<ProductDoc>('products', {
        term: 'shirt',
        sort: { title: 'asc' },
      })

      expect(result.hits.length).toBeGreaterThan(0)
      const titles = result.hits.map(h => h.document.title)
      for (let i = 1; i < titles.length; i++) {
        expect(titles[i].localeCompare(titles[i - 1])).toBeGreaterThanOrEqual(0)
      }
    })

    it('groups results by category', async () => {
      const result = await narsil.query<ProductDoc>('products', {
        term: 'set',
        group: { fields: ['category'], maxPerGroup: 3 },
      })

      expect(result.groups).toBeDefined()
      const groups = result.groups ?? []
      expect(groups.length).toBeGreaterThan(0)

      for (const group of groups) {
        expect(group.values.category).toBeDefined()
        expect(group.hits.length).toBeGreaterThan(0)
        expect(group.hits.length).toBeLessThanOrEqual(3)
      }
    })

    it('paginates with offset-based pagination', async () => {
      const page1 = await narsil.query<ProductDoc>('products', {
        term: 'wireless',
        limit: 5,
        offset: 0,
      })

      const page2 = await narsil.query<ProductDoc>('products', {
        term: 'wireless',
        limit: 5,
        offset: 5,
      })

      expect(page1.hits.length).toBe(5)
      expect(page2.hits.length).toBeGreaterThan(0)

      const page1Ids = new Set(page1.hits.map(h => h.id))
      for (const hit of page2.hits) {
        expect(page1Ids.has(hit.id)).toBe(false)
      }
    })

    it('highlights matched terms in the title field', async () => {
      const result = await narsil.query<ProductDoc>('products', {
        term: 'wireless',
        highlight: {
          fields: ['title'],
          preTag: '<b>',
          postTag: '</b>',
        },
      })

      expect(result.hits.length).toBeGreaterThan(0)

      const hitsWithHighlights = result.hits.filter(h => h.highlights?.title)
      expect(hitsWithHighlights.length).toBeGreaterThan(0)

      for (const hit of hitsWithHighlights) {
        expect(hit.highlights?.title.snippet).toContain('<b>')
        expect(hit.highlights?.title.snippet).toContain('</b>')
      }
    })

    it('pins a specific document to position 0', async () => {
      const lastDocId = docIds[docIds.length - 1]

      const result = await narsil.query<ProductDoc>('products', {
        term: 'wireless',
        pinned: [{ docId: lastDocId, position: 0 }],
      })

      expect(result.hits.length).toBeGreaterThan(0)
      expect(result.hits[0].id).toBe(lastDocId)
    })

    it('returns count without full results via preflight', async () => {
      const preflight = await narsil.preflight('products', { term: 'wireless' })

      expect(preflight.count).toBeGreaterThan(0)
      expect(preflight.elapsed).toBeGreaterThanOrEqual(0)

      const fullResult = await narsil.query<ProductDoc>('products', { term: 'wireless' })
      expect(preflight.count).toBe(fullResult.count)
    })
  })

  describe('combined search features', () => {
    it('combines filters, sorting, and pagination', async () => {
      const result = await narsil.query<ProductDoc>('products', {
        term: 'wireless',
        filters: {
          fields: {
            category: { eq: 'electronics' },
            price: { gte: 20, lte: 200 },
            inStock: { eq: true },
          },
        },
        sort: { price: 'asc' },
        limit: 5,
        offset: 0,
      })

      expect(result.hits.length).toBeGreaterThan(0)
      expect(result.hits.length).toBeLessThanOrEqual(5)

      for (const hit of result.hits) {
        expect(hit.document.category).toBe('electronics')
        expect(hit.document.price).toBeGreaterThanOrEqual(20)
        expect(hit.document.price).toBeLessThanOrEqual(200)
        expect(hit.document.inStock).toBe(true)
      }

      const prices = result.hits.map(h => h.document.price)
      for (let i = 1; i < prices.length; i++) {
        expect(prices[i]).toBeGreaterThanOrEqual(prices[i - 1])
      }

      if (result.count > 5) {
        const page2 = await narsil.query<ProductDoc>('products', {
          term: 'wireless',
          filters: {
            fields: {
              category: { eq: 'electronics' },
              price: { gte: 20, lte: 200 },
              inStock: { eq: true },
            },
          },
          sort: { price: 'asc' },
          limit: 5,
          offset: 5,
        })

        const page1Ids = new Set(result.hits.map(h => h.id))
        for (const hit of page2.hits) {
          expect(page1Ids.has(hit.id)).toBe(false)
        }
      }
    })

    it('combines facets with grouping', async () => {
      const result = await narsil.query<ProductDoc>('products', {
        term: 'set',
        facets: {
          category: {},
        },
        group: { fields: ['category'] },
      })

      expect(result.facets).toBeDefined()
      expect(result.facets?.category).toBeDefined()
      expect(Object.keys(result.facets?.category.values).length).toBeGreaterThan(0)

      expect(result.groups).toBeDefined()
      expect(result.groups?.length).toBeGreaterThan(0)

      const groupedCategories = new Set(result.groups?.map(g => g.values.category as string))
      const facetCategories = new Set(Object.keys(result.facets?.category.values))

      for (const cat of groupedCategories) {
        expect(facetCategories.has(cat)).toBe(true)
      }
    })

    it('combines highlighting with filters', async () => {
      const result = await narsil.query<ProductDoc>('products', {
        term: 'wireless keyboard',
        filters: {
          fields: {
            category: { eq: 'electronics' },
          },
        },
        highlight: {
          fields: ['title', 'description'],
        },
      })

      expect(result.hits.length).toBeGreaterThan(0)

      for (const hit of result.hits) {
        expect(hit.document.category).toBe('electronics')
      }

      const hitsWithHighlights = result.hits.filter(h => h.highlights?.title || h.highlights?.description)
      expect(hitsWithHighlights.length).toBeGreaterThan(0)
    })

    it('returns an empty result set for a term with no matches', async () => {
      const result = await narsil.query<ProductDoc>('products', {
        term: 'xyznonexistentterm',
      })

      expect(result.hits.length).toBe(0)
      expect(result.count).toBe(0)
    })

    it('returns all documents when no term is provided but filters are present', async () => {
      const result = await narsil.query<ProductDoc>('products', {
        filters: {
          fields: {
            category: { eq: 'electronics' },
            inStock: { eq: true },
          },
        },
        limit: 100,
      })

      for (const hit of result.hits) {
        expect(hit.document.category).toBe('electronics')
        expect(hit.document.inStock).toBe(true)
      }
    })
  })
})
