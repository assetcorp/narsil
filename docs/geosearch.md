# Geosearch

A geo field holds a latitude and a longitude, and this guide covers the radius and polygon filters that match against it.

Declare a `geopoint` field and insert documents with `{ lat, lon }` values. Geo conditions are filters that refine a search, so a geo query pairs a `term` (or a vector query) with a location filter, and it composes with other filters, facets, and every other query feature. A query carrying a location filter but no `term` matches nothing, because a filter narrows a term search rather than running a search of its own.

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

The engine measures the distance for a radius filter with the Haversine formula by default, in the `unit` that you set to `'km'`, `'mi'`, or `'m'`. It throws `SEARCH_INVALID_FILTER` for any other unit. Set `highPrecision: true` to have the engine use Vincenty's iterative formula, which is more accurate over long distances. The engine tests whether a point lies inside a polygon by ray casting, and it throws `SEARCH_INVALID_FILTER` for a polygon of fewer than three points, because such a ring encloses no area. List a polygon's points counter-clockwise around the area, as in an exterior ring of GeoJSON. Where the points span 180 degrees of longitude or more, the engine matches the area on the left of that path, so a ring in that order can cross the antimeridian, as a ring around Fiji must, or span more than half the globe. Set `inside: false` on either filter to match the documents outside the area. The engine adds a document to the geo index only when the document has coordinates, so under `inside: false` it matches only the documents that have a location. To select the documents outside the area together with those that have no location, wrap the filter in `not:`.
