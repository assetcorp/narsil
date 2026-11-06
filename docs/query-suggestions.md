# Popular query suggestions

Popular query suggestions let a search box offer whole searches, such as 'trail shoes', that other people ran and then followed with a click. The engine counts each search that your app reports, and once enough different people have searched for a phrase, a build publishes it to a suggestions index. A suggestions index is an ordinary Narsil index, so your app queries it the way it queries any other index.

People type private details into search boxes, so the feature stays off until you turn it on for an index. Leave it off for an index of private lookups, such as a register of phone numbers or account IDs.

## Turn it on

The engine needs a key of at least 32 bytes, which it uses to scramble the ID of each person before it stores anything. No snapshot, backup, or message between nodes holds the key, so keep it in your secret store and give every node of a cluster the same one.

```ts
import { createNarsil } from '@delali/narsil'
import { querySuggestions } from '@delali/narsil/query-suggestions'

const engine = await createNarsil({
  durability: { directory: './narsil-data' },
  querySuggestions: { key: process.env.NARSIL_SUGGESTIONS_KEY ?? '' },
})
const suggestions = querySuggestions(engine)

await suggestions.updateSetting('catalogue', { enabled: true, fields: ['title', 'brand'] })
```

The setting names the fields whose text a phrase must match. A build publishes a phrase only where at least `minResults` documents match every word of it in those fields, which defaults to 5, so a phrase that finds nothing in your catalogue never appears. Every other limit in `QuerySuggestionsSetting` has a default, and the TSDoc on each field gives its range.

Turning the feature off deletes the index's search history and leaves its suggestions indexes in place. Dropping the index drops its suggestions indexes and its history too.

## Count the searches that led to a click

Call `recordQuery` when a person clicks a result. The search path stays as it is, because the engine counts nothing that a search alone reports.

```ts
await suggestions.recordQuery('catalogue', { query: 'Trail shoes', person: 'person-1', group: 'shoppers' })
```

The engine normalises the text, so 'Trail shoes' and 'trail  shoes' count as one phrase. It counts a person once per phrase per day, it counts at most 100 new phrases from one person each day, and it refuses a phrase that holds anything other than letters, digits, spaces, hyphens, and apostrophes. The result tells you whether the engine counted the search, and `outcome` gives the reason where it didn't.

A group is an audience that gets separate suggestions, such as `shoppers` and `staff`. Use one group where every person should see the same suggestions.

Over HTTP, pass `querySuggestions.identify` to `createServer`. The server takes the person and the group from that function and never from the request body, because a caller who could choose the person could count one search as many people.

```ts
import { createServer } from '@delali/narsil/server'

const server = createServer(engine, {
  querySuggestions: {
    identify: ctx => {
      const session = sessionOf(ctx)
      return session === null ? null : { person: session.userId, group: session.audience }
    },
  },
})
```

`POST /indexes/catalogue/query-suggestions/record` then takes `{ "query": "trail shoes" }`, and the route answers 404 `QUERY_SUGGESTIONS_NOT_ENABLED` on a server without `identify`.

## Build and query the suggestions

A build runs at 03:00 UTC each day by default, and `schedule` takes any five-field cron expression, or `off`. Call `build` to run one now, and `preview` to see what the next build would publish without writing anything. The preview runs the same result checks as a build, so it lists a phrase only where it matches enough documents.

```ts
const build = await suggestions.build('catalogue')
const index = suggestions.suggestionsIndexName('catalogue', 'shoppers')
const found = await engine.query(index, { term: 'trai', prefix: true, termMatch: 'all', sort: { count: 'desc' } })
```

Each document of a suggestions index holds `query`, `count`, and `origin`, and its ID is the normalised phrase. `addSuggestion` adds a phrase by hand with `origin` set to `manual`, and a build leaves those in place.

`updateBans` replaces the list of phrases that the index never suggests, and `removeQuery` bans one phrase. Both remove the phrase from every suggestions index of the index before they return.

## Snapshots and backups

A snapshot holds the setting and the ban list. It holds the search history only where you ask for it with `engine.snapshot('catalogue', { queryHistory: true })`, or with `?queryHistory=true` over HTTP, because the history keeps raw searches past `retentionDays`. In a cluster, `cluster.createBackup('catalogue', 'nightly', { queryHistory: true })` adds the history of every node that answers.

A restore uses the history only where the restored index has the feature on and the node holds a key. A restore from a cluster backup checks every history file before it creates the index, and it refuses the backup with `BACKUP_DAMAGED` where any file differs from its digest.

## Cluster mode

Any node counts the searches that it receives, whether or not it holds a copy of the index, and it saves them in a history folder on its disk. Only the node that holds the controller lease builds, and it reads the counts of every node over the cluster transport. A node that receives a build request forwards it to that node.

## What to know before you turn it on

- Four people who work together can publish any phrase that matches enough documents, because the engine can't verify that a click happened. Raise `minPeople` for an index where that matters, and watch new suggestions with `preview`.
- A phrase can be a person's name where one of the listed `fields` holds names, such as an author or a staff field. List only fields whose values you are happy to show as suggestions.
- The history folder, `_query-counts/` under the durability directory, holds the text of each counted search. The IDs of the people are scrambled, but the searches are readable, so a manual copy of the data folder carries raw searches with it.
- A restore on a new server keeps the ban list that the snapshot or backup holds, so you must repeat every ban that you added after the snapshot was taken.
- A cluster node that loses its disk for good loses the counts that it held.
- A person whose searches reach two nodes of a cluster on one day can count twice towards a phrase's `count`, although they count once towards `minPeople`.
- A node without a key counts nothing and builds nothing, and it fires a `querySuggestionsWarning` event with the reason `no-key` for each index that has the feature on.
