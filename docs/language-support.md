# Language support

Narsil includes 107 language modules for tokenization, stemming, and stop word removal. This guide lists what each one covers, what the engine does when that analysis changes, and how to register analysis of your own.

Narsil includes 107 language modules for tokenization, stemming, and stop word removal.

## Full support (tokenizer + stemmer + stop words)

Arabic, Armenian, Basque, Bulgarian, Catalan, Czech, Danish, Dutch, English, Esperanto, Estonian, Finnish, French, German, Greek, Hindi, Hungarian, Indonesian, Irish, Italian, Lithuanian, Nepali, Norwegian, Persian, Polish, Portuguese, Romanian, Russian, Sanskrit, Serbian, Slovenian, Spanish, Swahili, Swedish, Tamil, Turkish, Ukrainian

Thirty-two of these stemmers come from the Snowball reference sources, and each one matches Snowball's own output on every word pair Snowball publishes, 11.4 million in all. The `NOTICE` file in this package carries the Snowball BSD-3-Clause licence that covers them. Bulgarian, Sanskrit, Slovenian, Swahili, and Ukrainian use stemmers written for Narsil, because Snowball publishes none for them.

## Character n-gram support (n-gram tokenizer + stop words)

Burmese, Chinese (Mandarin), Japanese, Khmer, Korean, Lao, and Thai write words with no space between them, so their modules split each run of script into overlapping two-character n-grams instead of on whitespace.

## Tokenizer and stop word support

Albanian, Amharic, Azerbaijani, Bambara, Belarusian, Bengali, Bosnian, Breton, Croatian, Dagbani, Ewe, Faroese, Fijian, Ga, Galician, Georgian, Guarani, Gujarati, Haitian Creole, Hausa, Hawaiian, Hebrew, Icelandic, Igbo, Kannada, Kazakh, Kinyarwanda, Kirundi, Kurmanji, Kyrgyz, Latin, Latvian, Lingala, Luxembourgish, Macedonian, Malagasy, Malay, Malayalam, Maltese, Maori, Marathi, Oromo, Punjabi, Samoan, Scottish Gaelic, Shona, Sinhala, Slovak, Sorani, Tagalog, Tatar, Telugu, Tibetan, Tigrinya, Tongan, Twi (Akan), Urdu, Vietnamese, Welsh, Wolof, Xhosa, Yoruba, and Zulu tokenize and filter stop words. Eleven of them also carry a normalizer that folds the spellings their orthography leaves optional. None of them has a stemmer, because Snowball publishes none for these languages.

## African language support

Twenty African languages are supported: Amharic, Bambara, Dagbani, Ewe, Ga, Hausa, Igbo, Kinyarwanda, Kirundi, Lingala, Malagasy, Oromo, Shona, Swahili, Tigrinya, Twi (Akan), Wolof, Xhosa, Yoruba, and Zulu. Swahili has a full stemmer, and the other nineteen tokenize and filter stop words. Each stop word list names its source in a comment at the top of its module, and a list with no published source records what it was curated from.

Each language module is a separate entry point, so you only bundle the languages your application needs. Import the module and register it before you create an index that names it:

```ts
import { createNarsil, registerLanguage } from '@delali/narsil'
import { french } from '@delali/narsil/languages/french'
import { swahili } from '@delali/narsil/languages/swahili'
import { twi } from '@delali/narsil/languages/twi'

registerLanguage(french)
registerLanguage(swahili)
registerLanguage(twi)

const narsil = await createNarsil()
await narsil.createIndex('articles', { schema: { title: 'string' }, language: 'french' })
```

English is registered by default, so it needs no import. Naming a language you have not registered fails with `LANGUAGE_NOT_SUPPORTED`.

`registerLanguage(module)` also adds a language of your own. A module carries a `name`, a `revision`, a `stemmer` or `null`, a `stopWords` set, an optional `normalizer` that folds token spellings before stemming, and an optional `tokenizer` that overrides the splitting defaults. Any of the built-in modules serves as a reference.

```ts
import { registerLanguage } from '@delali/narsil'
import { english } from '@delali/narsil/languages/english'

registerLanguage({
  ...english,
  name: 'english-legal',
  revision: '1',
  stopWords: new Set([...english.stopWords, 'hereinafter', 'whereto', 'whereas']),
})
```

Give a new language the revision `'1'`, and change that string whenever you change the stemmer, the normalizer, the stop words, or the tokenizer config. The next section explains what the engine does with the change.

## Analysis revisions

A change to a language module changes how it analyses text, so the terms an index already holds stop matching the terms a query produces. Every module carries a `revision` that identifies its analysis, and every index records the revision it was built with. On recovery the engine compares the two, and a difference marks the index stale.

Upgrading this package is the usual way an index goes stale, because a release that corrects a stemmer or a stop word list bumps that module's revision.

A stale index keeps answering. Every `query`, `preflight`, and `suggest` result for it carries `analysisStale: true`, and `listIndexes()` reports the same flag, so a caller can tell the results came from terms the current analysis no longer produces.

By default the engine rebuilds the terms in the background from the documents the index already stores, one partition at a time, and it rebuilds one index at a time. A rebuild re-analyses the text of every document in the index, so budget for it on a large one. It leaves vectors and embeddings untouched, because the revision covers text analysis alone. When it finishes, a durable engine writes the new revision into the index metadata and takes a checkpoint, so a later restart finds the index current.

Control the rebuild yourself when the timing matters. `rebuild: 'manual'` leaves every stale index alone, `listIndexes()` reports which ones they are, and `rebuildAnalysis(indexName)` resolves once every partition of one index carries current terms:

```ts
const narsil = await createNarsil({
  durability: { directory: './narsil-data' },
  analysis: { rebuild: 'manual' },
})

narsil.on('analysisRebuild', ({ indexName, status, partitionsRebuilt, partitionCount }) => {
  console.log(`${indexName}: ${status} ${partitionsRebuilt}/${partitionCount}`)
})

for (const index of narsil.listIndexes()) {
  if (index.analysisStale) await narsil.rebuildAnalysis(index.name)
}
```

Calling `rebuildAnalysis` for an index that is already current does nothing. A failed rebuild emits `analysisRebuild` with `status: 'failed'` and the error, and the index stays stale and answers from its old terms until you try again.

`onStaleAnalysis` covers the case the loop above cannot: it runs once for each stale index at startup, before an automatic rebuild begins, and it is the only place the stored and the current revision appear together.

```ts
const narsil = await createNarsil({
  durability: { directory: './narsil-data' },
  analysis: {
    onStaleAnalysis: index => {
      console.warn(`${index.indexName} was built with ${index.storedRevision}, ${index.language} now reports ${index.currentRevision}`)
    },
  },
})
```

Its second argument starts the rebuild for that index. Awaiting it inside the callback holds `createNarsil` open until the index finishes, which suits a deployment that must never answer from stale terms.

An index built by an engine older than the revision field records nothing about its analysis, so the engine treats it as stale and rebuilds it once.

A server deployment configures this the same way, because you build the engine and hand it to `createServer`. Set `analysis` on that engine and call `rebuildAnalysis` from your launcher; the REST API reports `analysisStale` on search responses but exposes no endpoint that starts a rebuild.

## Named tokenizers and stop words

An index config takes `stopWords` and `tokenizer` inline, and it also takes each one by name. Register the implementation once, then name it in any index config:

```ts
import { createNarsil, registerStopWords, registerTokenizer } from '@delali/narsil'

registerStopWords('catalogue-noise', defaults => new Set([...defaults, 'sku', 'refurbished']))
registerTokenizer('sku-codes', {
  tokenize: text =>
    text
      .toLowerCase()
      .split(/[\s/-]+/)
      .map((token, position) => ({ token, position })),
})

const narsil = await createNarsil()
await narsil.createIndex('products', {
  schema: { title: 'string' },
  stopWords: 'catalogue-noise',
  tokenizer: 'sku-codes',
})
```

A named binding works where an inline one cannot: persisted metadata cannot store a function, and a worker thread cannot receive one. Durability recovery rebinds a named tokenizer or stop word set from the registry, so register the names before calling `createNarsil` on a durable engine; an inline tokenizer or stop word function cannot persist. A worker thread resolves names from its own registry, filled by `workers.bootstrapModule`, so only an index using the named forms can promote; see [Workers](partitions-and-workers.md#workers).

Naming a tokenizer or stop word set you have not registered fails with `CONFIG_INVALID`, and the error's `details` list the registered names. `hasTokenizer(name)` and `hasStopWords(name)` report whether a name is registered, and `getTokenizer(name)` and `getStopWords(name)` return the registered implementation.
