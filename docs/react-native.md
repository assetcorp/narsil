# React Native

`@delali/narsil-react-native` runs a Narsil engine inside an iOS or Android app, so the app can search its own documents by keyword, by vector, or by both while the phone is offline. The engine works on a separate Hermes runtime, which means a long search or a large import leaves the app's JS thread free to draw the screen, and the engine keeps each index in files in the app's private storage, so the index survives a restart.

```ts
import { createNarsil } from '@delali/narsil-react-native'

const narsil = await createNarsil()
await narsil.createIndex('notes', {
  schema: { title: 'string', embedding: 'vector[384]' },
  language: 'english',
})
await narsil.insert('notes', { title: 'Pack the tent poles', embedding: tentVector })
const { hits } = await narsil.query('notes', { term: 'tent', limit: 10 })
```

Every method of the client resolves through a promise, including the ones that answer at once on the `Narsil` interface of `@delali/narsil`, such as `listIndexes`, because each call crosses to the engine's runtime and back. Otherwise each method takes the same arguments and returns the same answer as the method of the same name in [Indexes and documents](indexes-and-documents.md).

## What the app needs

The package carries native code, which compiles the C search core for iOS and for 64-bit Android, so it works only in an app build that includes that code. Expo Go has no such build, and neither does a 32-bit Android phone, so in both cases `createNarsil` rejects with `NATIVE_DEPENDENCY_MISSING`. The app needs React Native's New Architecture, `react-native-nitro-modules` to reach the native code, and `react-native-worklets` to start the engine's runtime.

Install the four packages in the app:

```bash
npm install @delali/narsil @delali/narsil-react-native react-native-nitro-modules react-native-worklets
```

The engine's runtime loads the package's code through Worklets Bundle Mode, so the app's Babel and Metro settings have to turn Bundle Mode on and forward the package's imports to that runtime. The two sections below give those settings for an app with Expo and for an app without it.

## Set up an Expo app

Add the config plugin to `app.json`, which limits the Android build to 64-bit architectures, because the native module ships no 32-bit library:

```json
{
  "expo": {
    "plugins": ["@delali/narsil-react-native"]
  }
}
```

Turn on Bundle Mode in `babel.config.js`, and forward the package's source to the engine's runtime:

```js
module.exports = api => {
  api.cache(true)
  return {
    presets: [['babel-preset-expo', { worklets: false }]],
    plugins: [
      [
        'react-native-worklets/plugin',
        {
          bundleMode: true,
          strictGlobal: true,
          importForwarding: { relativePaths: ['@delali/narsil-react-native/src'] },
        },
      ],
    ],
  }
}
```

Wrap the Metro config in `metro.config.js`:

```js
const { getDefaultConfig } = require('expo/metro-config')
const { getBundleModeMetroConfig } = require('react-native-worklets/bundleMode')

module.exports = getBundleModeMetroConfig(getDefaultConfig(__dirname))
```

Then make a development build with `npx expo run:ios` or `npx expo run:android`. The app in [`packages/react-native/examples/expo`](../packages/react-native/examples/expo) uses these settings.

## Set up an app without Expo

Use the Babel preset that the React Native template already carries, and add the same Worklets plugin to `babel.config.js`:

```js
module.exports = {
  presets: ['module:@react-native/babel-preset'],
  plugins: [
    [
      'react-native-worklets/plugin',
      {
        bundleMode: true,
        strictGlobal: true,
        importForwarding: { relativePaths: ['@delali/narsil-react-native/src'] },
      },
    ],
  ],
}
```

Wrap the Metro config in `metro.config.js`:

```js
const { getDefaultConfig } = require('@react-native/metro-config')
const { getBundleModeMetroConfig } = require('react-native-worklets/bundleMode')

module.exports = getBundleModeMetroConfig(getDefaultConfig(__dirname))
```

Set the Android architectures in `android/gradle.properties`, which the Expo plugin would otherwise set for you:

```properties
reactNativeArchitectures=arm64-v8a,x86_64
```

Run `pod install` in the `ios` folder, then rebuild the app for each platform. The app in [`packages/react-native/examples/bare`](../packages/react-native/examples/bare) uses these settings.

## Where the index lives

`createNarsil()` turns on a write-ahead log in a `narsil` directory inside the app's private storage, which is `Library/Application Support` on iOS and the app's files directory on Android. The engine syncs each write to that log before the write resolves, so a write that has resolved survives the app being ended. Pass another `directory` in `durability` to keep the files somewhere else; a relative path resolves against the private storage, while an absolute path stays as it is. Pass `durability: null` to keep the index in memory alone.

```ts
const narsil = await createNarsil({ durability: { directory: 'search' } })
```

On iOS the engine syncs each file with `F_FULLFSYNC`, which asks the drive to write its own cache to storage as well. Under durability, the engine keeps a vector field's full-precision vectors in files and reads them when it ranks a search, as [Vector search](vector-search.md) describes.

## Snapshots and exports

`snapshot` resolves with the bytes of one `.nrsl` file, and `restore` takes those bytes back. A snapshot from a phone restores on a server, and a server's snapshot restores on a phone, because both write the same format.

For an index too large to hold twice in memory, pass a path in place of the bytes. `snapshotToFile` writes the snapshot to a file and resolves with its size in bytes, and `restoreFromFile` reads a snapshot from a file in chunks:

```ts
await narsil.snapshotToFile('notes', 'backups/notes.nrsl')
await narsil.restoreFromFile('notes', 'backups/notes.nrsl')
```

`exportDocumentsToFile` and `importDocumentExportFromFile` do the same for a document export. Each path resolves against the app's private storage in the same way as the durability directory.

## Settings that hold a function

Each setting that crosses to the engine's runtime has to cross as data, so `createNarsil` leaves out every setting that holds a function, such as an embedding adapter, a plugin, or an id generator. Pass those through the second argument, a function marked with the `'worklet'` directive, which runs on the engine's runtime before the engine starts and returns the settings that hold functions. Register a language module or a tokenizer inside that function too, because the engine's runtime keeps its own copy of each module.

## Memory

A phone ends an app that uses too much memory, so the engine refuses an insert or an update that could take the app past its limit, with `MEMORY_WRITE_BLOCKED`. On iOS the limit is the app's memory footprint plus the memory that `os_proc_available_memory()` reports, and on Android it is the available memory that `ActivityManager` reports, less its low-memory threshold. Removes, searches, and reads keep working while writes are blocked, as [The memory write block](observability.md#the-memory-write-block) describes.

## Errors

A failed call rejects with an error that carries the engine's `code` and `details`. `isNarsilError` from `@delali/narsil-react-native` tells a Narsil error from any other error, and [Errors](errors.md) lists every code:

```ts
import { isNarsilError } from '@delali/narsil-react-native'

try {
  await narsil.restore('notes', bytes)
} catch (error) {
  if (isNarsilError(error) && error.code === 'PERSISTENCE_LOAD_FAILED') showDamagedBackupMessage()
}
```

A damaged checkpoint or snapshot file and an invalid vector each raise a typed error, and the app stays open.
