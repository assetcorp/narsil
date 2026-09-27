# Search inside a browser page

Put the engine in a Web Worker that the app creates, so that the page stays responsive while the engine indexes and searches. The page starts the worker:

```ts
const worker = new Worker(new URL('./search-worker.ts', import.meta.url), { type: 'module' })
```

`search-worker.ts` holds the engine and answers each message:

```ts
import { createNarsil, isNarsilError, type Narsil } from '@delali/narsil'
import { createIndexedDBPersistence } from '@delali/narsil/adapters/indexeddb'

const CATALOGUE_LOADED = 'products-loaded'

async function openCatalogue(): Promise<Narsil> {
  const narsil = await createNarsil({ persistence: createIndexedDBPersistence({ dbName: 'shop-search' }) })
  try {
    const saved = new Set(narsil.listIndexes().map(index => index.name))
    if (!saved.has(CATALOGUE_LOADED)) {
      if (saved.has('products')) await narsil.dropIndex('products')
      await narsil.createIndex('products', { schema: { title: 'string', price: 'number' } })
      const response = await fetch('/products.json')
      if (!response.ok) throw new Error(`The catalogue download failed with status ${response.status}`)
      await narsil.insertBatch('products', await response.json())
      await narsil.checkpoint('products')
      await narsil.createIndex(CATALOGUE_LOADED, { schema: { loadedAt: 'number' } })
    }
    return narsil
  } catch (error) {
    await narsil.shutdown()
    throw error
  }
}

let ready: Promise<Narsil> | undefined

self.onmessage = async (event: MessageEvent<{ id: number; term: string }>) => {
  try {
    ready ??= openCatalogue().catch(error => {
      ready = undefined
      throw error
    })
    const narsil = await ready
    const results = await narsil.query('products', { term: event.data.term, tolerance: 1, limit: 20 })
    self.postMessage({ id: event.data.id, hits: results.hits })
  } catch (error) {
    self.postMessage({ id: event.data.id, code: isNarsilError(error) ? error.code : 'UNEXPECTED' })
  }
}
```

- `createNarsil` recovers every saved index from IndexedDB before it resolves, so on a later visit the worker skips the download and the load, and the search works with no network.
- With IndexedDB, the engine saves an index every 5 minutes by default, or after 100,000 writes, so closing the tab sooner discards the load. `narsil.checkpoint(indexName)` saves the index at once, so call it after each load.
- `createIndex` saves the new index's name and schema before the load starts, so an index that exists can still be empty or half loaded. The worker creates the `products-loaded` index only once the checkpoint has finished, so a failed download or a tab that the user closes part-way through leaves no marker. The next start then drops the half-loaded `products` index and loads it again.
- When the start fails, the worker answers every waiting message with an error, and the next message starts the engine again.
- IndexedDB keeps the index on the device, but the page itself loads with no network only when the app registers a service worker that caches its files.
- In a browser, the engine keeps its own worker pool off, so the engine answers every query on the thread that holds it, which here is the worker that the app created.
- Keep vectors out of each message with `document: { exclude: [...] }`, because the browser copies every hit that `postMessage` sends.
- To keep several tabs consistent over one IndexedDB store, pass `invalidation: createBroadcastChannelInvalidation()` from `@delali/narsil/invalidation/broadcast-channel` to `createNarsil` in each tab.
- The transformers adapter from [vectors.md](vectors.md) also embeds in the browser, where it caches the model in the Cache API after the first download. Pass `device: 'webgpu'` to embed on the GPU where the browser offers WebGPU.
