export type SchemaDefinition = Record<string, string | Record<string, string>>

export const tmdbSchema: SchemaDefinition = {
  title: 'string',
  overview: 'string',
  tagline: 'string',
  genres: 'string[]',
  original_language: 'enum',
  vote_average: 'number',
  popularity: 'number',
  runtime: 'number',
  revenue: 'number',
  release_year: 'number',
  production_countries: 'string[]',
  status: 'enum',
}

export const wikipediaSchema: SchemaDefinition = {
  title: 'string',
  text: 'string',
  language: 'enum',
  categories: 'string[]',
}

export const scifactSchema: SchemaDefinition = {
  title: 'string',
  text: 'string',
}

export const placesSchema: SchemaDefinition = {
  name: 'string:sortable:pattern:partial',
  summary: 'string',
  country: 'string:pattern',
  region: 'string:pattern',
  kind: 'enum',
  tags: 'enum[]',
  population: 'number',
  populations: 'number[]',
  location: 'geopoint',
}
