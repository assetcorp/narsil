import { afterEach, describe, expect, it } from 'vitest'
import { createNarsil, type Narsil } from '../../narsil'
import { createMemoryPersistence } from '../../persistence/memory'
import type { AnyDocument, IndexConfig, SchemaDefinition } from '../../types/schema'

const schema: SchemaDefinition = {
  title: 'string' as const,
  description: 'string' as const,
  price: 'number' as const,
  inStock: 'boolean' as const,
  category: 'enum' as const,
}

const indexConfig: IndexConfig = {
  schema,
  language: 'english',
}

interface Product {
  title: string
  description: string
  price: number
  inStock: boolean
  category: string
}

const productTemplates: Product[] = [
  {
    title: 'Wireless Bluetooth Headphones',
    description: 'Premium over-ear headphones with active noise cancellation and 30-hour battery life.',
    price: 149.99,
    inStock: true,
    category: 'electronics',
  },
  {
    title: 'USB-C Fast Charging Cable',
    description: 'Durable braided cable for fast charging and data transfer at high speeds.',
    price: 12.99,
    inStock: true,
    category: 'electronics',
  },
  {
    title: 'Mechanical Gaming Keyboard',
    description: 'RGB backlit keyboard with cherry switches for responsive typing and gaming.',
    price: 89.99,
    inStock: true,
    category: 'electronics',
  },
  {
    title: 'Portable Bluetooth Speaker',
    description: 'Waterproof speaker with 360-degree sound and built-in microphone.',
    price: 59.99,
    inStock: true,
    category: 'electronics',
  },
  {
    title: '4K Ultra HD Monitor',
    description: 'IPS display with wide color gamut and adjustable stand for professional work.',
    price: 429.99,
    inStock: false,
    category: 'electronics',
  },
  {
    title: 'Wireless Optical Mouse',
    description: 'Ergonomic mouse with adjustable DPI settings and long battery life.',
    price: 29.99,
    inStock: true,
    category: 'electronics',
  },
  {
    title: 'Noise Cancelling Earbuds',
    description: 'True wireless earbuds with active noise cancellation and transparency mode.',
    price: 199.99,
    inStock: true,
    category: 'electronics',
  },
  {
    title: 'HDMI to USB-C Adapter',
    description: 'Compact adapter for connecting displays to modern laptops and tablets.',
    price: 19.99,
    inStock: true,
    category: 'electronics',
  },
  {
    title: 'Smart Home Hub Controller',
    description: 'Central hub for managing all connected smart devices throughout your house.',
    price: 79.99,
    inStock: false,
    category: 'electronics',
  },
  {
    title: 'Laptop Cooling Pad',
    description: 'Slim cooling pad with dual fans and adjustable angle for better airflow.',
    price: 34.99,
    inStock: true,
    category: 'electronics',
  },
  {
    title: 'Portable Power Bank',
    description: 'High capacity power bank with dual USB ports for charging on the go.',
    price: 39.99,
    inStock: true,
    category: 'electronics',
  },
  {
    title: 'Digital Drawing Tablet',
    description: 'Pressure-sensitive tablet for digital art and graphic design workflows.',
    price: 249.99,
    inStock: true,
    category: 'electronics',
  },
  {
    title: 'Webcam HD 1080p',
    description: 'Wide-angle webcam with built-in microphone for video calls and streaming.',
    price: 49.99,
    inStock: true,
    category: 'electronics',
  },
  {
    title: 'External SSD Drive 1TB',
    description: 'Compact solid state drive with fast read and write speeds for backup.',
    price: 109.99,
    inStock: true,
    category: 'electronics',
  },
  {
    title: 'Wireless Charging Pad',
    description: 'Qi-compatible charging pad for phones and earbuds with LED indicator.',
    price: 24.99,
    inStock: true,
    category: 'electronics',
  },
  {
    title: 'Smart LED Desk Lamp',
    description: 'Adjustable desk lamp with color temperature control and dimming options.',
    price: 44.99,
    inStock: true,
    category: 'electronics',
  },
  {
    title: 'Bluetooth Audio Receiver',
    description: 'Small receiver that adds wireless audio capability to any wired speaker system.',
    price: 22.99,
    inStock: false,
    category: 'electronics',
  },
  {
    title: 'USB Microphone Studio Grade',
    description: 'Condenser microphone with cardioid pattern for podcasting and recording.',
    price: 129.99,
    inStock: true,
    category: 'electronics',
  },
  {
    title: 'Network Ethernet Switch',
    description: 'Eight-port gigabit switch for reliable wired networking at home or office.',
    price: 29.99,
    inStock: true,
    category: 'electronics',
  },
  {
    title: 'Cable Management Kit',
    description: 'Complete set of clips, ties, and sleeves for organizing desk cables neatly.',
    price: 14.99,
    inStock: true,
    category: 'electronics',
  },

  {
    title: 'Modern JavaScript Programming',
    description: 'A thorough guide to JavaScript covering ES6 features and async patterns.',
    price: 39.99,
    inStock: true,
    category: 'books',
  },
  {
    title: 'Data Structures and Algorithms',
    description: 'Learn fundamental computer science concepts with practical coding examples.',
    price: 49.99,
    inStock: true,
    category: 'books',
  },
  {
    title: 'The Art of Clean Code',
    description: 'Principles and patterns for writing maintainable and readable software.',
    price: 34.99,
    inStock: true,
    category: 'books',
  },
  {
    title: 'Introduction to Machine Learning',
    description: 'Beginner-friendly guide to ML concepts with Python implementations.',
    price: 54.99,
    inStock: false,
    category: 'books',
  },
  {
    title: 'Distributed Systems Design',
    description: 'Architecture patterns for building scalable and fault-tolerant systems.',
    price: 59.99,
    inStock: true,
    category: 'books',
  },
  {
    title: 'TypeScript in Practice',
    description: 'Hands-on examples for building type-safe applications with TypeScript.',
    price: 44.99,
    inStock: true,
    category: 'books',
  },
  {
    title: 'Database Internals Explained',
    description: 'Deep exploration of storage engines, indexing, and query optimization.',
    price: 64.99,
    inStock: true,
    category: 'books',
  },
  {
    title: 'Web Security Fundamentals',
    description: 'Essential knowledge for protecting web applications from common threats.',
    price: 29.99,
    inStock: true,
    category: 'books',
  },
  {
    title: 'Cloud Native Architecture',
    description: 'Building applications designed for containerized cloud environments.',
    price: 49.99,
    inStock: false,
    category: 'books',
  },
  {
    title: 'Functional Programming Guide',
    description: 'Explore functional paradigms and how they improve code quality.',
    price: 42.99,
    inStock: true,
    category: 'books',
  },
  {
    title: 'DevOps Handbook Revised',
    description: 'Strategies for continuous delivery and operational excellence in teams.',
    price: 37.99,
    inStock: true,
    category: 'books',
  },
  {
    title: 'Network Programming with Go',
    description: 'Build networked services and distributed applications using Go.',
    price: 47.99,
    inStock: true,
    category: 'books',
  },
  {
    title: 'Linux Command Line Mastery',
    description: 'From basic commands to shell scripting for system administration.',
    price: 32.99,
    inStock: true,
    category: 'books',
  },
  {
    title: 'API Design Patterns',
    description: 'Proven patterns for designing consistent and user-friendly REST APIs.',
    price: 52.99,
    inStock: true,
    category: 'books',
  },
  {
    title: 'Concurrency in Rust',
    description: 'Safe concurrent programming techniques using the Rust ownership model.',
    price: 46.99,
    inStock: false,
    category: 'books',
  },
  {
    title: 'Site Reliability Engineering',
    description: 'Principles for running reliable production systems at scale.',
    price: 55.99,
    inStock: true,
    category: 'books',
  },
  {
    title: 'Microservices Architecture',
    description: 'Designing loosely coupled services for large-scale applications.',
    price: 48.99,
    inStock: true,
    category: 'books',
  },
  {
    title: 'Graph Databases in Action',
    description: 'Modeling and querying connected data using graph database technologies.',
    price: 41.99,
    inStock: true,
    category: 'books',
  },
  {
    title: 'Test-Driven Development Guide',
    description: 'Write better software by letting tests drive your design decisions.',
    price: 36.99,
    inStock: true,
    category: 'books',
  },
  {
    title: 'Operating Systems Concepts',
    description: 'Core OS topics including processes, memory management, and file systems.',
    price: 69.99,
    inStock: true,
    category: 'books',
  },

  {
    title: 'Cotton Crew Neck T-Shirt',
    description: 'Soft breathable cotton tee available in multiple colors for daily wear.',
    price: 19.99,
    inStock: true,
    category: 'clothing',
  },
  {
    title: 'Slim Fit Denim Jeans',
    description: 'Classic denim jeans with stretch fabric for comfortable movement all day.',
    price: 49.99,
    inStock: true,
    category: 'clothing',
  },
  {
    title: 'Waterproof Winter Jacket',
    description: 'Insulated jacket with sealed seams and adjustable hood for cold weather.',
    price: 129.99,
    inStock: true,
    category: 'clothing',
  },
  {
    title: 'Merino Wool Sweater',
    description: 'Lightweight sweater made from fine merino wool for warmth without bulk.',
    price: 79.99,
    inStock: false,
    category: 'clothing',
  },
  {
    title: 'Athletic Running Shorts',
    description: 'Lightweight shorts with moisture-wicking fabric and built-in liner.',
    price: 29.99,
    inStock: true,
    category: 'clothing',
  },
  {
    title: 'Leather Belt Classic Brown',
    description: 'Full grain leather belt with brass buckle for formal and casual outfits.',
    price: 34.99,
    inStock: true,
    category: 'clothing',
  },
  {
    title: 'Fleece Zip-Up Hoodie',
    description: 'Warm fleece hoodie with front zip and kangaroo pockets for layering.',
    price: 44.99,
    inStock: true,
    category: 'clothing',
  },
  {
    title: 'Linen Button-Down Shirt',
    description: 'Breathable linen shirt perfect for warm weather and casual occasions.',
    price: 54.99,
    inStock: true,
    category: 'clothing',
  },
  {
    title: 'Compression Leggings',
    description: 'High-waist leggings with compression fit for workouts and active wear.',
    price: 39.99,
    inStock: true,
    category: 'clothing',
  },
  {
    title: 'Rain Resistant Windbreaker',
    description: 'Packable windbreaker with water-resistant coating and reflective details.',
    price: 64.99,
    inStock: true,
    category: 'clothing',
  },
  {
    title: 'Casual Canvas Sneakers',
    description: 'Lightweight canvas shoes with rubber sole for everyday casual style.',
    price: 42.99,
    inStock: true,
    category: 'clothing',
  },
  {
    title: 'Bamboo Fiber Socks Pack',
    description: 'Six-pair pack of soft bamboo fiber socks with cushioned arch support.',
    price: 18.99,
    inStock: true,
    category: 'clothing',
  },
  {
    title: 'Quilted Vest Insulated',
    description: 'Lightweight quilted vest for layering in transitional weather conditions.',
    price: 59.99,
    inStock: false,
    category: 'clothing',
  },
  {
    title: 'Stretch Chino Pants',
    description: 'Tailored chino pants with added stretch for comfort in office or weekend.',
    price: 54.99,
    inStock: true,
    category: 'clothing',
  },
  {
    title: 'Wool Blend Beanie Hat',
    description: 'Warm knit beanie in a soft wool blend for cold weather head coverage.',
    price: 16.99,
    inStock: true,
    category: 'clothing',
  },
  {
    title: 'UV Protection Sunglasses',
    description: 'Polarized lenses with UV400 protection in a lightweight durable frame.',
    price: 27.99,
    inStock: true,
    category: 'clothing',
  },
  {
    title: 'Oxford Dress Shoes',
    description: 'Classic leather oxford shoes with cushioned insole for formal events.',
    price: 89.99,
    inStock: true,
    category: 'clothing',
  },
  {
    title: 'Thermal Base Layer Top',
    description: 'Moisture-wicking thermal top for cold weather outdoor activities.',
    price: 34.99,
    inStock: true,
    category: 'clothing',
  },
  {
    title: 'Wide Brim Sun Hat',
    description: 'Packable sun hat with UPF 50 protection for beach and hiking trips.',
    price: 24.99,
    inStock: true,
    category: 'clothing',
  },
  {
    title: 'Silk Pocket Square',
    description: 'Hand-rolled silk pocket square for adding polish to suit jackets.',
    price: 22.99,
    inStock: false,
    category: 'clothing',
  },

  {
    title: 'Running Trail Shoes',
    description: 'Grippy trail running shoes with cushioned midsole for rough terrain.',
    price: 119.99,
    inStock: true,
    category: 'sports',
  },
  {
    title: 'Yoga Mat Premium Thick',
    description: 'Non-slip yoga mat with alignment marks and carrying strap included.',
    price: 39.99,
    inStock: true,
    category: 'sports',
  },
  {
    title: 'Adjustable Dumbbell Set',
    description: 'Space-saving adjustable dumbbells from 5 to 50 pounds per hand.',
    price: 299.99,
    inStock: true,
    category: 'sports',
  },
  {
    title: 'Resistance Band Kit',
    description: 'Five bands with different resistance levels plus handles and door anchor.',
    price: 24.99,
    inStock: true,
    category: 'sports',
  },
  {
    title: 'Cycling Water Bottle',
    description: 'BPA-free squeeze bottle with quick-flow valve for hydration on rides.',
    price: 14.99,
    inStock: true,
    category: 'sports',
  },
  {
    title: 'Tennis Racket Professional',
    description: 'Lightweight graphite racket with vibration dampening for competitive play.',
    price: 159.99,
    inStock: false,
    category: 'sports',
  },
  {
    title: 'Jump Rope Speed Cable',
    description: 'Adjustable speed rope with ball bearings for double-unders and cardio.',
    price: 19.99,
    inStock: true,
    category: 'sports',
  },
  {
    title: 'Foam Roller Recovery',
    description: 'High-density foam roller for muscle recovery and flexibility training.',
    price: 29.99,
    inStock: true,
    category: 'sports',
  },
  {
    title: 'Basketball Indoor Outdoor',
    description: 'Composite leather basketball with deep channels for grip in all conditions.',
    price: 34.99,
    inStock: true,
    category: 'sports',
  },
  {
    title: 'Swim Goggles Anti-Fog',
    description: 'Leak-proof goggles with anti-fog coating and UV protection for pool use.',
    price: 17.99,
    inStock: true,
    category: 'sports',
  },
  {
    title: 'Hiking Backpack 40L',
    description: 'Ventilated back panel backpack with rain cover for multi-day hikes.',
    price: 89.99,
    inStock: true,
    category: 'sports',
  },
  {
    title: 'Boxing Gloves Training',
    description: 'Padded training gloves with wrist support for bag work and sparring.',
    price: 44.99,
    inStock: true,
    category: 'sports',
  },
  {
    title: 'Soccer Ball Official Size',
    description: 'Match quality soccer ball with thermal bonded panels for true flight.',
    price: 29.99,
    inStock: true,
    category: 'sports',
  },
  {
    title: 'Pull-Up Bar Doorway',
    description: 'No-screw doorway pull-up bar with foam grips and multiple hold positions.',
    price: 34.99,
    inStock: true,
    category: 'sports',
  },
  {
    title: 'Compression Arm Sleeves',
    description: 'UV protection arm sleeves with graduated compression for sports activities.',
    price: 14.99,
    inStock: true,
    category: 'sports',
  },
  {
    title: 'Electric Muscle Massager',
    description: 'Percussion massager with multiple heads for deep tissue muscle relief.',
    price: 79.99,
    inStock: true,
    category: 'sports',
  },
  {
    title: 'Fitness Tracker Watch',
    description: 'Waterproof fitness tracker with heart rate monitor and step counter.',
    price: 69.99,
    inStock: false,
    category: 'sports',
  },
  {
    title: 'Weightlifting Gloves',
    description: 'Padded gloves with wrist wraps for lifting protection and grip.',
    price: 22.99,
    inStock: true,
    category: 'sports',
  },
  {
    title: 'Badminton Racket Set',
    description: 'Two racket set with shuttlecocks and carrying case for recreational play.',
    price: 39.99,
    inStock: true,
    category: 'sports',
  },
  {
    title: 'Ab Roller Exercise Wheel',
    description: 'Dual wheel roller with knee pad for core strength training at home.',
    price: 19.99,
    inStock: true,
    category: 'sports',
  },

  {
    title: 'Stainless Steel Water Filter',
    description: 'Countertop water filter removing contaminants while preserving minerals.',
    price: 89.99,
    inStock: true,
    category: 'home',
  },
  {
    title: 'Bamboo Cutting Board Set',
    description: 'Three-piece cutting board set with juice grooves and easy-grip handles.',
    price: 29.99,
    inStock: true,
    category: 'home',
  },
  {
    title: 'Cast Iron Skillet 12-Inch',
    description: 'Pre-seasoned cast iron pan for searing, baking, and stovetop cooking.',
    price: 34.99,
    inStock: true,
    category: 'home',
  },
  {
    title: 'Ceramic Plant Pot Collection',
    description: 'Set of four decorative ceramic pots in varying sizes for indoor plants.',
    price: 44.99,
    inStock: true,
    category: 'home',
  },
  {
    title: 'Memory Foam Pillow',
    description: 'Contoured memory foam pillow for proper neck alignment during sleep.',
    price: 49.99,
    inStock: true,
    category: 'home',
  },
  {
    title: 'Automatic Soap Dispenser',
    description: 'Touchless infrared sensor dispenser with adjustable foam volume control.',
    price: 24.99,
    inStock: true,
    category: 'home',
  },
  {
    title: 'LED String Lights Warm',
    description: 'Fairy string lights with warm white LEDs for ambient room decoration.',
    price: 14.99,
    inStock: true,
    category: 'home',
  },
  {
    title: 'Microfiber Cleaning Cloths',
    description: 'Pack of twelve reusable microfiber cloths for streak-free cleaning.',
    price: 12.99,
    inStock: true,
    category: 'home',
  },
  {
    title: 'French Press Coffee Maker',
    description: 'Borosilicate glass press with stainless steel frame for rich coffee.',
    price: 29.99,
    inStock: true,
    category: 'home',
  },
  {
    title: 'Organic Cotton Bed Sheets',
    description: 'Percale weave bed sheet set in organic cotton for a cool sleep surface.',
    price: 79.99,
    inStock: false,
    category: 'home',
  },
  {
    title: 'Drawer Organizer Expandable',
    description: 'Adjustable bamboo organizer for utensils, tools, and desk accessories.',
    price: 22.99,
    inStock: true,
    category: 'home',
  },
  {
    title: 'Essential Oil Diffuser',
    description: 'Ultrasonic aroma diffuser with color-changing LED and timer settings.',
    price: 34.99,
    inStock: true,
    category: 'home',
  },
  {
    title: 'Stainless Steel Mixing Bowls',
    description: 'Nesting bowl set with non-slip base and measurement markings inside.',
    price: 27.99,
    inStock: true,
    category: 'home',
  },
  {
    title: 'Wall Mounted Shelf Set',
    description: 'Floating shelves in natural wood finish for books and decorative items.',
    price: 39.99,
    inStock: true,
    category: 'home',
  },
  {
    title: 'Silicone Baking Mat Set',
    description: 'Two non-stick baking mats fitting standard sheet pans for even baking.',
    price: 16.99,
    inStock: true,
    category: 'home',
  },
  {
    title: 'Insulated Travel Mug',
    description: 'Double-wall vacuum mug keeping drinks hot for eight hours on the go.',
    price: 24.99,
    inStock: true,
    category: 'home',
  },
  {
    title: 'Bathroom Shower Caddy',
    description: 'Rust-proof stainless steel caddy with hooks for organized shower storage.',
    price: 19.99,
    inStock: true,
    category: 'home',
  },
  {
    title: 'Electric Kettle Temperature',
    description: 'Variable temperature kettle with keep-warm function for tea and pour-over.',
    price: 54.99,
    inStock: true,
    category: 'home',
  },
  {
    title: 'Kitchen Scale Digital',
    description: 'Precision digital scale with tare function and backlit display for cooking.',
    price: 18.99,
    inStock: true,
    category: 'home',
  },
  {
    title: 'Vacuum Storage Bags Large',
    description: 'Space-saving vacuum bags for compressing blankets, pillows, and clothing.',
    price: 21.99,
    inStock: false,
    category: 'home',
  },
]

function generateDocuments(): Product[] {
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

describe('E2E Full Workflow', () => {
  let narsil: Narsil
  const documents = generateDocuments()
  const insertedIds: string[] = []

  afterEach(async () => {
    if (narsil) {
      await narsil.shutdown()
    }
  })

  it('runs a complete product catalog workflow end-to-end', async () => {
    narsil = await createNarsil({
      persistence: createMemoryPersistence(),
    })

    await narsil.createIndex('products', indexConfig)

    const indexes = narsil.listIndexes()
    expect(indexes.length).toBe(1)
    expect(indexes[0].name).toBe('products')

    const batchResult = await narsil.insertBatch('products', documents as unknown as AnyDocument[])
    expect(batchResult.succeeded.length).toBe(200)
    expect(batchResult.failed.length).toBe(0)
    insertedIds.push(...batchResult.succeeded)

    const count = await narsil.countDocuments('products')
    expect(count).toBe(200)

    const searchResult = await narsil.query('products', {
      term: 'wireless headphones',
    })
    expect(searchResult.hits.length).toBeGreaterThan(0)
    expect(searchResult.count).toBeGreaterThan(0)
    expect(searchResult.elapsed).toBeGreaterThanOrEqual(0)

    const hasWireless = searchResult.hits.some(hit => {
      const doc = hit.document as Record<string, unknown>
      const title = (doc.title as string).toLowerCase()
      const desc = (doc.description as string).toLowerCase()
      return (
        title.includes('wireless') ||
        desc.includes('wireless') ||
        title.includes('headphone') ||
        desc.includes('headphone')
      )
    })
    expect(hasWireless).toBe(true)

    const filteredResult = await narsil.query('products', {
      term: 'cable charging',
      filters: {
        fields: {
          price: { gte: 50, lte: 200 },
          inStock: { eq: true },
        },
      },
    })
    for (const hit of filteredResult.hits) {
      const doc = hit.document as Record<string, unknown>
      expect(doc.price as number).toBeGreaterThanOrEqual(50)
      expect(doc.price as number).toBeLessThanOrEqual(200)
      expect(doc.inStock).toBe(true)
    }

    const facetResult = await narsil.query('products', {
      term: 'premium',
      facets: { category: {} },
      limit: 200,
    })
    expect(facetResult.facets).toBeDefined()
    expect(facetResult.facets?.category).toBeDefined()
    const facetValues = facetResult.facets?.category.values ?? {}
    const facetCategories = Object.keys(facetValues)
    expect(facetCategories.length).toBeGreaterThan(0)

    const sortedResult = await narsil.query('products', {
      term: 'shoes',
      sort: { price: 'asc' },
    })
    if (sortedResult.hits.length > 1) {
      const prices = sortedResult.hits.map(h => (h.document as Record<string, unknown>).price as number)
      for (let i = 1; i < prices.length; i++) {
        expect(prices[i]).toBeGreaterThanOrEqual(prices[i - 1])
      }
    }

    const page1 = await narsil.query('products', {
      term: 'cotton leather wool',
      limit: 5,
      offset: 0,
    })
    expect(page1.hits.length).toBeLessThanOrEqual(5)

    const page2 = await narsil.query('products', {
      term: 'cotton leather wool',
      limit: 5,
      offset: 5,
    })
    expect(page2.hits.length).toBeLessThanOrEqual(5)

    if (page1.hits.length > 0 && page2.hits.length > 0) {
      const page1Ids = new Set(page1.hits.map(h => h.id))
      for (const hit of page2.hits) {
        expect(page1Ids.has(hit.id)).toBe(false)
      }
    }

    const highlightResult = await narsil.query('products', {
      term: 'wireless',
      highlight: {
        fields: ['title'],
        preTag: '<b>',
        postTag: '</b>',
      },
    })
    expect(highlightResult.hits.length).toBeGreaterThan(0)
    const highlightedHit = highlightResult.hits.find(h => h.highlights?.title)
    expect(highlightedHit).toBeDefined()
    if (highlightedHit?.highlights?.title) {
      expect(highlightedHit.highlights.title.snippet).toContain('<b>')
      expect(highlightedHit.highlights.title.snippet).toContain('</b>')
    }

    const idsToUpdate = insertedIds.slice(0, 10)
    const newPrice = 999.99
    for (const docId of idsToUpdate) {
      const existing = await narsil.get('products', docId)
      if (existing) {
        await narsil.update('products', docId, {
          ...existing,
          price: newPrice,
        })
      }
    }

    for (const docId of idsToUpdate) {
      const updated = await narsil.get('products', docId)
      expect(updated).toBeDefined()
      expect(updated?.price).toBe(newPrice)
    }

    const idsToRemove = insertedIds.slice(10, 20)
    const removeResult = await narsil.removeBatch('products', idsToRemove)
    expect(removeResult.succeeded.length).toBe(10)
    expect(removeResult.failed.length).toBe(0)

    for (const docId of idsToRemove) {
      const gone = await narsil.get('products', docId)
      expect(gone).toBeUndefined()
      const exists = await narsil.has('products', docId)
      expect(exists).toBe(false)
    }

    const finalCount = await narsil.countDocuments('products')
    expect(finalCount).toBe(190)

    await narsil.shutdown()
  }, 30_000)

  it('supports preflight queries for fast count estimation', async () => {
    narsil = await createNarsil()
    await narsil.createIndex('products', indexConfig)
    await narsil.insertBatch('products', documents.slice(0, 50) as unknown as AnyDocument[])

    const preflightResult = await narsil.preflight('products', { term: 'wireless' })
    expect(preflightResult.count).toBeGreaterThanOrEqual(0)
    expect(preflightResult.elapsed).toBeGreaterThanOrEqual(0)

    const fullResult = await narsil.query('products', { term: 'wireless' })
    expect(preflightResult.count).toBe(fullResult.count)
  })

  it('handles clear and re-insert within the same index', async () => {
    narsil = await createNarsil()
    await narsil.createIndex('products', indexConfig)

    await narsil.insertBatch('products', documents.slice(0, 20) as unknown as AnyDocument[])
    const beforeClear = await narsil.countDocuments('products')
    expect(beforeClear).toBe(20)

    await narsil.clear('products')
    const afterClear = await narsil.countDocuments('products')
    expect(afterClear).toBe(0)

    const indexesAfterClear = narsil.listIndexes()
    expect(indexesAfterClear.map(i => i.name)).toContain('products')

    await narsil.insertBatch('products', documents.slice(0, 10) as unknown as AnyDocument[])
    const afterReinsert = await narsil.countDocuments('products')
    expect(afterReinsert).toBe(10)

    const searchAfterReinsert = await narsil.query('products', { term: 'wireless' })
    expect(searchAfterReinsert.elapsed).toBeGreaterThanOrEqual(0)
  })

  it('filters with combined boolean and numeric constraints', async () => {
    narsil = await createNarsil()
    await narsil.createIndex('products', indexConfig)
    await narsil.insertBatch('products', documents as unknown as AnyDocument[])

    const result = await narsil.query('products', {
      term: 'keyboard shoes jacket pillow',
      filters: {
        and: [{ fields: { inStock: { eq: true } } }, { fields: { price: { between: [20, 100] } } }],
      },
    })

    for (const hit of result.hits) {
      const doc = hit.document as Record<string, unknown>
      expect(doc.inStock).toBe(true)
      expect(doc.price as number).toBeGreaterThanOrEqual(20)
      expect(doc.price as number).toBeLessThanOrEqual(100)
    }
  })

  it('returns correct stats after mutations', async () => {
    narsil = await createNarsil()
    await narsil.createIndex('products', indexConfig)
    await narsil.insertBatch('products', documents.slice(0, 30) as unknown as AnyDocument[])

    const stats = narsil.getStats('products')
    expect(stats.documentCount).toBe(30)
    expect(stats.partitionCount).toBeGreaterThanOrEqual(1)
    expect(stats.language).toBe('english')
    expect(stats.schema).toEqual(schema)
  })
})
