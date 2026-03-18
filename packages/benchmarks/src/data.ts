import type { BenchDocument, VectorBenchDocument } from './types'

function createRng(seed: number): () => number {
  let s = seed | 0
  return () => {
    s |= 0
    s = (s + 0x6d2b79f5) | 0
    let t = Math.imul(s ^ (s >>> 15), 1 | s)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const VOCABULARY = [
  'server',
  'client',
  'protocol',
  'network',
  'hardware',
  'software',
  'firmware',
  'interface',
  'module',
  'component',
  'framework',
  'library',
  'runtime',
  'kernel',
  'process',
  'thread',
  'socket',
  'endpoint',
  'gateway',
  'proxy',
  'firewall',
  'container',
  'cluster',
  'instance',
  'deployment',
  'pipeline',
  'queue',
  'broker',
  'middleware',
  'controller',
  'service',
  'adapter',
  'driver',
  'handler',
  'listener',
  'database',
  'table',
  'column',
  'row',
  'record',
  'field',
  'schema',
  'migration',
  'index',
  'partition',
  'shard',
  'replica',
  'snapshot',
  'backup',
  'archive',
  'cache',
  'buffer',
  'pool',
  'heap',
  'stack',
  'tree',
  'graph',
  'hash',
  'document',
  'collection',
  'namespace',
  'bucket',
  'volume',
  'block',
  'page',
  'search',
  'query',
  'filter',
  'sort',
  'rank',
  'score',
  'match',
  'token',
  'stem',
  'analyze',
  'parse',
  'tokenize',
  'normalize',
  'weight',
  'boost',
  'relevance',
  'precision',
  'recall',
  'frequency',
  'position',
  'offset',
  'highlight',
  'snippet',
  'facet',
  'aggregate',
  'group',
  'reduce',
  'project',
  'create',
  'read',
  'update',
  'delete',
  'insert',
  'remove',
  'merge',
  'split',
  'transform',
  'encode',
  'decode',
  'compress',
  'extract',
  'validate',
  'verify',
  'monitor',
  'track',
  'measure',
  'profile',
  'benchmark',
  'test',
  'debug',
  'deploy',
  'scale',
  'balance',
  'route',
  'schedule',
  'execute',
  'invoke',
  'fast',
  'slow',
  'large',
  'small',
  'stable',
  'volatile',
  'secure',
  'reliable',
  'available',
  'durable',
  'consistent',
  'efficient',
  'concurrent',
  'parallel',
  'sequential',
  'synchronous',
  'asynchronous',
  'mutable',
  'immutable',
  'stateful',
  'stateless',
  'ephemeral',
  'persistent',
  'pattern',
  'strategy',
  'factory',
  'observer',
  'mediator',
  'decorator',
  'layer',
  'tier',
  'boundary',
  'domain',
  'context',
  'scope',
  'lifecycle',
  'event',
  'signal',
  'message',
  'payload',
  'header',
  'body',
  'response',
  'request',
  'stream',
  'channel',
  'topic',
  'subscription',
  'notification',
  'system',
  'platform',
  'application',
  'engine',
  'machine',
  'device',
  'sensor',
  'config',
  'setting',
  'parameter',
  'variable',
  'constant',
  'function',
  'method',
  'class',
  'type',
  'value',
  'key',
  'name',
  'label',
  'tag',
  'version',
  'error',
  'warning',
  'failure',
  'timeout',
  'retry',
  'fallback',
  'recovery',
  'metric',
  'counter',
  'gauge',
  'histogram',
  'trace',
  'span',
  'log',
  'audit',
  'policy',
  'rule',
  'constraint',
  'threshold',
  'limit',
  'quota',
  'budget',
  'resource',
  'capacity',
  'throughput',
  'latency',
  'bandwidth',
  'overhead',
  'algorithm',
  'heuristic',
  'optimization',
  'iteration',
  'recursion',
  'traversal',
]

const CATEGORIES = [
  'engineering',
  'research',
  'operations',
  'analytics',
  'infrastructure',
  'security',
  'platform',
  'data',
]

function zipfianIndex(rng: () => number, poolSize: number): number {
  return Math.min(Math.floor(poolSize * rng() ** 2), poolSize - 1)
}

function generateSentence(rng: () => number, wordCount: number): string {
  const words: string[] = []
  for (let i = 0; i < wordCount; i++) {
    words.push(VOCABULARY[zipfianIndex(rng, VOCABULARY.length)])
  }
  return words.join(' ')
}

export function generateDocuments(count: number, seed: number): BenchDocument[] {
  const rng = createRng(seed)
  const docs: BenchDocument[] = []
  for (let i = 0; i < count; i++) {
    const titleLength = 3 + Math.floor(rng() * 10)
    const bodyLength = 30 + Math.floor(rng() * 70 + rng() * 70)
    docs.push({
      id: `doc-${String(i).padStart(7, '0')}`,
      title: generateSentence(rng, titleLength),
      body: generateSentence(rng, bodyLength),
      score: Math.floor(rng() * 100),
      category: CATEGORIES[Math.floor(rng() * CATEGORIES.length)],
    })
  }
  return docs
}

export function generateQueries(count: number, seed: number): string[] {
  const rng = createRng(seed)
  const queries: string[] = []
  for (let i = 0; i < count; i++) {
    const wordCount = 1 + Math.floor(rng() * 3)
    queries.push(generateSentence(rng, wordCount))
  }
  return queries
}

export function generateMultiTermQueries(count: number, seed: number): string[] {
  const rng = createRng(seed)
  const queries: string[] = []
  for (let i = 0; i < count; i++) {
    const wordCount = 2 + Math.floor(rng() * 2)
    queries.push(generateSentence(rng, wordCount))
  }
  return queries
}

function generateUnitVector(rng: () => number, dimension: number): number[] {
  const vec: number[] = new Array(dimension)
  let magnitude = 0
  for (let i = 0; i < dimension; i++) {
    const g = (rng() + rng() + rng() - 1.5) * 2
    vec[i] = g
    magnitude += g * g
  }
  magnitude = Math.sqrt(magnitude)
  if (magnitude > 0) {
    for (let i = 0; i < dimension; i++) {
      vec[i] /= magnitude
    }
  }
  return vec
}

export function generateVectorDocuments(count: number, dimension: number, seed: number): VectorBenchDocument[] {
  const rng = createRng(seed)
  const docs: VectorBenchDocument[] = []
  for (let i = 0; i < count; i++) {
    const titleLength = 3 + Math.floor(rng() * 10)
    docs.push({
      id: `vec-${String(i).padStart(7, '0')}`,
      title: generateSentence(rng, titleLength),
      embedding: generateUnitVector(rng, dimension),
    })
  }
  return docs
}

export function generateQueryVectors(count: number, dimension: number, seed: number): number[][] {
  const rng = createRng(seed)
  const vectors: number[][] = []
  for (let i = 0; i < count; i++) {
    vectors.push(generateUnitVector(rng, dimension))
  }
  return vectors
}

export function generateDocumentBatch(count: number, seed: number, offset: number): BenchDocument[] {
  const rng = createRng(seed)
  const docs: BenchDocument[] = []
  for (let i = 0; i < count; i++) {
    const titleLength = 3 + Math.floor(rng() * 10)
    const bodyLength = 30 + Math.floor(rng() * 70 + rng() * 70)
    docs.push({
      id: `doc-${String(offset + i).padStart(7, '0')}`,
      title: generateSentence(rng, titleLength),
      body: generateSentence(rng, bodyLength),
      score: Math.floor(rng() * 100),
      category: CATEGORIES[Math.floor(rng() * CATEGORIES.length)],
    })
  }
  return docs
}

export function generateVectorDocumentBatch(
  count: number,
  dimension: number,
  seed: number,
  offset: number,
): VectorBenchDocument[] {
  const rng = createRng(seed)
  const docs: VectorBenchDocument[] = []
  for (let i = 0; i < count; i++) {
    const titleLength = 3 + Math.floor(rng() * 10)
    docs.push({
      id: `vec-${String(offset + i).padStart(7, '0')}`,
      title: generateSentence(rng, titleLength),
      embedding: generateUnitVector(rng, dimension),
    })
  }
  return docs
}

export function generateFilteredQueries(count: number, seed: number): string[] {
  const rng = createRng(seed)
  const queries: string[] = []
  for (let i = 0; i < count; i++) {
    const wordCount = 1 + Math.floor(rng() * 2)
    queries.push(generateSentence(rng, wordCount))
  }
  return queries
}

export { createRng }
