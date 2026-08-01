# Geosearch

A geo field holds a latitude and a longitude, and this guide covers the radius and polygon filters that match against it.

Declare a `geopoint` field and insert documents with `{ lat, lon }` values. Geo conditions are filters that refine a search, so a geo query pairs a `term` (or a vector query) with a location filter, and it composes with other filters, facets, and every other query feature. A query with only a location filter and no `term` matches nothing, the same way any other filter refines a term search.

```ts
await narsil.createIndex('stores', {
  schema: {
    name: 'string',
    location: 'geopoint',
  },
})

await narsil.insert('stores', {
  name: 'Osu Night Market',
  location: { lat: 5.5571, lon: -0.1824 },
})

const nearby = await narsil.query('stores', {
  term: 'market',
  filters: {
    fields: {
      location: {
        radius: { lat: 5.556, lon: -0.1969, distance: 5, unit: 'km' },
      },
    },
  },
})

const inArea = await narsil.query('stores', {
  term: 'market',
  filters: {
    fields: {
      location: {
        polygon: {
          points: [
            { lat: 5.52, lon: -0.25 },
            { lat: 5.52, lon: -0.15 },
            { lat: 5.62, lon: -0.15 },
            { lat: 5.62, lon: -0.25 },
          ],
        },
      },
    },
  },
})
```

Radius filters measure Haversine distance by default and accept `unit: 'km' | 'mi' | 'm'`. Set `highPrecision: true` to switch to Vincenty's iterative formula for long-distance accuracy. Polygon filters test containment with ray casting. Both filter shapes accept `inside: false` to invert the match and return documents outside the area.
