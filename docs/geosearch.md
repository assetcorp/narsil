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

Radius filters measure Haversine distance by default and accept `unit: 'km' | 'mi' | 'm'`, while any other unit raises `SEARCH_INVALID_FILTER`. Set `highPrecision: true` to switch to Vincenty's iterative formula for long-distance accuracy. Polygon filters test containment with ray casting, and a polygon of fewer than three points raises `SEARCH_INVALID_FILTER`, because such a ring encloses no area. List a polygon's points counter-clockwise around the area, which is the order that GeoJSON specifies. Where the points span 180 degrees of longitude or more, the engine matches the area on the left of that path, so a ring listed that way can cross the antimeridian, as a ring around Fiji does, or span more than half the globe. Both filter shapes accept `inside: false` to invert the match and return documents outside the area. A document that carries no coordinates never enters the geo index, so `inside: false` leaves it out, and you would wrap the filter in `not:` to select the documents outside the area together with the ones that hold no location at all.
