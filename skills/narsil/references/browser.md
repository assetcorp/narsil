# Search inside a browser page

Put the engine in a Web Worker that the app creates, so that the page stays responsive while the engine indexes and searches. The page starts the worker:

```ts
const worker = new Worker(new URL('./search-worker.ts', import.meta.url), { type: 'module' })
```

`search-worker.ts` holds the engine and answers each message:

```ts
import { createNarsil, isNarsilError } from '@delali/narsil'
import { createIndexedDBPersistence } from '@delali/narsil/adapters/indexeddb'

const ready = (async () => {
  const narsil = await createNarsil({ persistence: createIndexedDBPersistence({ dbName: 'shop-search' }) })
  if (!narsil.listIndexes().some(index => index.name === 'products')) {
    await narsil.createIndex('products', { schema: { title: 'string', price: 'number' } })
    await narsil.insertBatch('products', await (await fetch('/products.json')).json())
    await narsil.checkpoint('products')
  }
  return narsil
})()

self.onmessage = async (event: MessageEvent<{ id: number; term: string }>) => {
  const narsil = await ready
  try {
    const results = await narsil.query('products', { term: event.data.term, tolerance: 1, limit: 20 })
    self.postMessage({ id: event.data.id, hits: results.hits })
  } catch (error) {
    self.postMessage({ id: event.data.id, code: isNarsilError(error) ? error.code : 'UNEXPECTED' })
  }
}
```

- `createNarsil` recovers every saved index from IndexedDB before it resolves, so on a later visit the worker skips the download and the load, and the search works with no network.
- With IndexedDB, the engine saves an index every 5 minutes by default, or after 100,000 writes, so closing the tab sooner discards the load. `narsil.checkpoint(indexName)` saves the index at once, so call it after each load.
- IndexedDB keeps the index on the device, but the page itself loads with no network only when the app registers a service worker that caches its files.
- In a browser, the engine keeps its own worker pool off, so the engine answers every query on the thread that holds it, which here is the worker that the app created.
- Keep vectors out of each message with `document: { exclude: [...] }`, because the browser copies every hit that `postMessage` sends.
- To keep several tabs consistent over one IndexedDB store, pass `invalidation: createBroadcastChannelInvalidation()` from `@delali/narsil/invalidation/broadcast-channel` to `createNarsil` in each tab.
- The transformers adapter from [vectors.md](vectors.md) also embeds in the browser, where it caches the model in the Cache API after the first download. Pass `device: 'webgpu'` to embed on the GPU where the browser offers WebGPU.
