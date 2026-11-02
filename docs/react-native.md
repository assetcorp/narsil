# React Native

`@delali/narsil-react-native` runs a Narsil engine inside an iOS or Android app, so the app can search its own documents by keyword, by vector, or by both while the phone is offline. The engine keeps each index in files in the app's private storage, so the index survives a restart.

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

The engine works on the app's own JS runtime and takes the same settings as on Node.js, so you can pass an embedding adapter, a plugin, a tokenizer, or an id generator to `createNarsil` directly. Every method of the client resolves through a promise, including the ones that answer at once on the `Narsil` interface of `@delali/narsil`, such as `listIndexes`. Otherwise each method takes the same arguments and returns the same answer as the method of the same name in [Indexes and documents](indexes-and-documents.md).

The engine keeps its slow work off the JS thread so that the app can keep drawing the screen. Each file read, file write, and file sync runs on a native thread, and so does each vector search and each scan of many vectors through the C search core. During a large import or a search, the engine hands the JS thread back to the app every 20 milliseconds of its own work, so a touch or a frame waits for one step of an import, never for the whole import.

## What the app needs

The package carries native code, which compiles the C search core for iOS and for 64-bit Android, so it works only in an app build that includes that code. Expo Go has no such build, and neither does a 32-bit Android phone, so in both cases `createNarsil` rejects with `NATIVE_DEPENDENCY_MISSING`. The app needs React Native's New Architecture and `react-native-nitro-modules`, which lets JavaScript call the native code.

## Set up an Expo app

1. Install the packages:

   ```bash
   npx expo install @delali/narsil @delali/narsil-react-native react-native-nitro-modules
   ```

2. Add the config plugin to `app.json`, which limits the Android build to 64-bit architectures, because the native module ships no 32-bit library:

   ```json
   {
     "expo": {
       "plugins": ["@delali/narsil-react-native"]
     }
   }
   ```

3. Make a development build with `npx expo run:ios` or `npx expo run:android`.

The app keeps its Babel and Metro settings as they are. The app in [`packages/react-native/examples/expo`](../packages/react-native/examples/expo) follows these three steps.

## Set up an app without Expo

Install the packages:

```bash
npm install @delali/narsil @delali/narsil-react-native react-native-nitro-modules
```

Set the Android architectures in `android/gradle.properties`, which the Expo plugin would otherwise set for you:

```properties
reactNativeArchitectures=arm64-v8a,x86_64
```

Run `pod install` in the `ios` folder, then rebuild the app for each platform. The app keeps its Babel and Metro settings as they are.

## Run the engine on its own runtime

An app whose own JavaScript keeps the JS thread busy can move the engine's JavaScript to a separate Hermes runtime as well. `createNarsil` from `@delali/narsil-react-native/worklets` starts the engine on a [Worklets](https://docs.swmansion.com/react-native-worklets/) runtime and returns the same client. An app that never imports that entry point bundles none of its code and needs no Worklets install.

That runtime loads the package's code through Worklets Bundle Mode, so the app has to install `react-native-worklets`, turn Bundle Mode on in its Babel settings, and wrap its Metro config:

```bash
npm install react-native-worklets
```

In an Expo app, `babel.config.js` turns Bundle Mode on and forwards the package's source to the engine's runtime:

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

and `metro.config.js` wraps the Metro config:

```js
const { getDefaultConfig } = require('expo/metro-config')
const { getBundleModeMetroConfig } = require('react-native-worklets/bundleMode')

module.exports = getBundleModeMetroConfig(getDefaultConfig(__dirname))
```

In an app without Expo, `babel.config.js` adds the same plugin to the React Native preset:

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

and `metro.config.js` wraps the React Native Metro config:

```js
const { getDefaultConfig } = require('@react-native/metro-config')
const { getBundleModeMetroConfig } = require('react-native-worklets/bundleMode')

module.exports = getBundleModeMetroConfig(getDefaultConfig(__dirname))
```

Bundle Mode writes each worklet to a new file under `react-native-worklets/.worklets` while Metro builds the bundle. When Metro has not yet indexed one of those files, the build stops with `Failed to get the SHA-1` for it, which is what happened on this repository's continuous integration runners. The [Bundle Mode setup guide](https://docs.swmansion.com/react-native-worklets/docs/bundleMode/setup/) recommends a patch to Metro for this and links a patch for each Metro version. This repository applies its own version of that patch through pnpm's `patchedDependencies`, in [`patches/metro@0.87.2.patch`](../patches/metro@0.87.2.patch), which hashes a Bundle Mode file from its contents whenever Metro has no record of it.

The app in [`packages/react-native/examples/bare`](../packages/react-native/examples/bare) uses these settings and runs its searches through this entry point.

Each setting has to cross to that runtime as data, so this entry point leaves out every setting that holds a function. Pass those through the second argument, a function marked with the `'worklet'` directive, which runs on the engine's runtime before the engine starts and returns the settings that hold functions. Register a language module or a tokenizer inside that function too, because the engine's runtime keeps its own copy of each module.

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
