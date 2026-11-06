# Narsil Popular Query Suggestions Specification

Popular query suggestions let a search box suggest a whole search, such as 'running shoes', once enough people have searched for it. A node counts each search that a person follows with a click, and a build publishes each phrase that enough people searched for as a document in an ordinary index, the suggestions index, which an app queries as it queries any other index.

People can type private details into a search box, so a node must keep the feature off for every index until a caller turns it on. With the feature off, a node stores no search text for the index.

The feature reuses the [32-byte header](envelope.md#32-byte-header-permanent-contract), the [atomic write](durability.md#atomic-write), and the [snapshot archive](durability.md#snapshot-archive). It adds a setting, a ban list, a marker on each suggestions index, a history folder, a build, optional entries in the snapshot archive, and two node messages.

---

## The Setting

A caller turns the feature on for one index through the `querySuggestions` setting:

```text
QuerySuggestionsSetting {
  enabled:               boolean
  fields:                List<string>          (the string fields whose text a published phrase must match)
  minPeople:             uint32 or absent
  minResults:            uint32 or absent
  retentionDays:         uint32 or absent
  maxPhrasesPerDay:      uint32 or absent
  maxPhrasesPerPerson:   uint32 or absent
  maxPeoplePerDay:       uint32 or absent
  maxGroups:             uint32 or absent
  minLetters:            uint32 or absent
  maxLength:             uint32 or absent
  maxWords:              uint32 or absent
  maxDigits:             uint32 or absent
  maxMergePhrases:       uint32 or absent
  mergeMemoryBytes:      uint64 or absent
  saveIntervalMs:        uint32 or absent
  resultChecksPerSecond: uint32 or absent
  schedule:              string or absent      ("0 3 * * *" where absent, or "off")
  timeZone:              string or absent      ("UTC" where absent)
}
```

Each limit takes its default where it is absent, and a node must refuse a value outside its range:

| Limit | Default | Range |
|-------|---------|-------|
| `minPeople` | 4 | 2 to 4,096 |
| `minResults` | 5 | 1 to 10,000 |
| `retentionDays` | 30 | 1 to 365 |
| `maxPhrasesPerDay` | 10,000 | 1 to 16,384 |
| `maxPhrasesPerPerson` | 100 | 1 to 1,000 |
| `maxPeoplePerDay` | 100,000 | 1 to 100,000 |
| `maxGroups` | 100 | 1 to 1,000 |
| `minLetters` | 4 | 1 to `maxLength` |
| `maxLength` | 100 | 1 to 150 |
| `maxWords` | 8 | 1 to 50 |
| `maxDigits` | 5 | 0 to `maxLength` |
| `maxMergePhrases` | 100,000 | 1 to 500,000 |
| `mergeMemoryBytes` | 134,217,728 | 16,777,216 to 1,073,741,824 |
| `saveIntervalMs` | 300,000 | 1,000 to 3,600,000 |
| `resultChecksPerSecond` | 20 | 1 to 1,000 |

Three products are bounded too, because each one bounds memory or a file:

- `maxPeoplePerDay` × `maxPhrasesPerPerson` at most 10,000,000, the pairs that [Counting](#counting) holds.
- `maxPhrasesPerDay` × `minPeople` at most 65,536, the scrambled IDs that one history file holds.
- `maxMergePhrases` × `minPeople` at most 2,097,152, the scrambled IDs that a merge holds.

A node must refuse the setting with `CONFIG_INVALID` where a limit or a product breaks these rules, and in each of these cases:

- `fields` is empty, holds more than 32 paths, names a path twice, or names a path that is not a `string` or `string[]` field of the schema.
- The MessagePack encoding of the setting is longer than 16,384 bytes.
- `schedule` is neither `off` nor a cron expression of five fields, as [Schedule](#schedule) defines, or `timeZone` names no IANA time zone in the node's time zone database.
- The node has no key, as [The Key](#the-key) defines, and `enabled` is true.
- The index has [device sync](sync.md) on, because a device receives the whole index of one user, while a suggestion comes from the searches of several people. A node must likewise refuse to turn sync on for an index with this feature on.
- The index carries the [marker](#the-suggestions-index) of a suggestions index.
- The index name is longer than 210 characters, because the name of each suggestions index adds up to 45 characters.

Turning the feature off must delete the index's [history](#history) and discard the counts of the current day that the node holds in memory, so that the node keeps no search text for the index. It leaves every suggestions index of the index in place.

The index metadata, the index configuration payload, and `IndexSettings` hold the setting, so that every [snapshot archive](durability.md#snapshot-archive) and every [backup](distribution/backups.md) of the index holds it.

### The Key

A node scrambles each person's ID with a secret key, which the operator gives the node as configuration and which no payload holds. The key is a byte string of at least 32 bytes, and a key given as text is its UTF-8 bytes. Every node of a cluster must hold the same key, because the scrambled IDs of one person must match on every node.

- The scrambled ID of a person is the first 16 bytes of HMAC-SHA-256 of the person's ID as UTF-8, under the key.
- The key's fingerprint is the first 16 bytes of HMAC-SHA-256 of the UTF-8 text `narsil.query-suggestions.key`, under the key.

A node without a key counts nothing and builds nothing. Where it holds an index whose setting has `enabled` true, such as one that a caller restored there, it must tell the operator, and it must refuse every count for that index.

### The Ban List

The ban list of an index is a `List<string>` of [normalised phrases](#phrases), held next to the setting as a synonym set is. Each phrase holds at most 150 code points and only the code points that [Phrases](#phrases) allows, whatever the setting's own limits are, so that a change of the setting never invalidates a stored list. A node must store each phrase in its normal form and once, and it must refuse with `CONFIG_INVALID` a list of more than 1,000 phrases, or one whose MessagePack encoding is longer than 262,144 bytes.

- A node must refuse every count of a banned phrase.
- A build must publish no banned phrase, and it must remove every banned phrase from each suggestions index, whatever the phrase's `origin`.
- Adding a phrase to the ban list must remove that phrase from every suggestions index of the index before the call returns.
- History files that hold a banned phrase keep it until they expire, and a build ignores it.

In a cluster, `IndexSettings` is one coordinator value, and etcd accepts 1,572,864 bytes in one request by default. The feature's values take at most 16,384 bytes for the setting and 262,144 bytes for the ban list. Their key names, the [marker](#the-suggestions-index) of up to 326 bytes, and the synonym set's `SynonymSetRef` take under 1,024 bytes together, because [Synonym Set Storage](distribution/cluster.md#synonym-set-storage) keeps the set itself under separate keys. That makes at most 279,552 bytes, which leaves 1,293,312 bytes for the schema, the stop words, and every other key, and a cluster refuses an index whose metadata passes the limit, as it does for every index.

---

## Phrases

A node normalises a phrase in five steps:

1. Apply Unicode normalisation form NFKC.
2. Apply the Unicode default lowercase mapping, which depends on no locale.
3. Replace U+2018, U+2019, and U+02BC with U+0027, and U+2010 and U+2011 with U+002D.
4. Replace each run of code points with the White_Space property with one U+0020.
5. Remove U+0020 from the start and the end.

A node must accept a normalised phrase only where each of its code points is a letter (general category L), a mark (M), a decimal digit (Nd), U+0020, U+002D, or U+0027, and where the phrase holds at least `minLetters` letters, at most `maxLength` code points, at most `maxWords` words separated by U+0020, and at most `maxDigits` decimal digits in total. The normalised phrase is the document ID of its suggestion, so two spellings of a phrase that differ only in case and spaces give one suggestion. At 150 code points, a phrase takes at most 300 UTF-16 code units, within the 512 that a document ID allows.

A person's ID is a string of 1 to 256 UTF-16 code units. A group is a string of 1 to 32 characters, where the first is a letter or a digit and the rest are letters, digits, `_`, and `-`, so that no group can reach a key outside the history folder.

---

## Counting

An app records a search that a person followed with a click, and the node counts it against the person, the phrase, and the person's group. The server takes the person and the group from the request through code that the operator supplies, never from the request body, so that a caller can't choose them.

A node keeps the counts of one day, a calendar day in UTC, for each index. It must refuse a count, record nothing, and report the refusal to the caller as a count that it did not record, where:

- the phrase fails [Phrases](#phrases) or is on the ban list
- the group fails [Phrases](#phrases), or it would be a new group while `maxGroups` groups are already known, where the known groups are those that any history file of the index on the node names, the day's counts in memory included, together with those that hold a suggestions index whose marker names the index
- the person has already counted for that phrase in that group on that day, in which case the count changes nothing
- the person would count a new phrase on that day after `maxPhrasesPerPerson` phrases
- the phrase would be new on that day after the node holds `maxPhrasesPerDay` phrases for the index, counted across every group
- the person would be new on that day after the node holds `maxPeoplePerDay` people for the index

A node must tell the operator once each day that it reaches `maxPhrasesPerDay` or `maxPeoplePerDay` for an index.

For each group and phrase of the day, a node keeps `count`, the number of people that it counted, and `people`, the scrambled IDs of up to `minPeople` of them. To refuse a repeated count, it keeps each pair of a person and a phrase that it counted that day. A node holds what it needs to refuse a repeated count in memory alone, apart from the IDs in `people`, so a restart can count a person a second time towards `count`, although never towards `people`.

### Memory

A node must hold the counts of one day for one index, the file that it writes from them included, in at most 67,108,864 bytes (64 MiB). The ranges of [The Setting](#the-setting) allow that, where a node holds each part as follows:

| Part | How a node holds it | Bytes at the ceilings |
|------|---------------------|----------------------|
| Phrases | 16,384 phrases, each a key of up to 300 UTF-16 code units in its group's table, with its count and the place of its people, at 768 bytes each | 12,582,912 |
| Groups | 1,000 groups, each a name and a table, at 256 bytes each | 256,000 |
| People | 100,000 people, each a 16-byte scrambled ID, a slot in a hash table at a load of at most one half, a count of phrases, and the first and last block of its list, at 64 bytes each | 6,400,000 |
| Pairs | 10,000,000 phrase numbers of 2 bytes, in blocks of 16 with a 4-byte link to the next block, so 36 bytes a block: at most 625,000 full blocks, one part-used block for each person, and one unused page of 16,384 blocks | 26,689,824 |
| People lists | 65,536 scrambled IDs of 16 bytes, up to `minPeople` for each phrase | 1,048,576 |
| The file | 16,384 phrases of up to 632 bytes each, 65,536 scrambled IDs of 18 bytes, 1,000 groups of up to 39 bytes, and 200 bytes for the rest of the map, a 36-byte `indexUuid` included | 11,573,536 |
| Total | | 58,550,848 |

A phrase number fits in 2 bytes because `maxPhrasesPerDay` stays below 65,536, and a phrase of 150 code points takes at most 600 bytes as UTF-8. That total leaves 8,558,016 bytes of the 64 MiB for the rest of the node's work on the index. A node may hold these parts in another way, as long as it keeps within the same total.

---

## History

Each node writes the counts of one day for one index to `_query-counts/<indexName>/<day>.nrsl`, where `<day>` is the day as `YYYY-MM-DD`. A filesystem node writes the file with an [atomic write](durability.md#atomic-write), and a node with a persistence adapter saves the same key through the adapter. A node without either keeps the counts in memory, and a restart loses them.

- A node must write the file of the current day at least once every `saveIntervalMs` while its counts change, when the day ends, and on a clean shutdown. A crash therefore loses up to `saveIntervalMs` of counts.
- A node must tell the operator when a write fails, and it must keep the counts in memory and write them again at the next interval.
- A node must delete a file once its day lies more than `retentionDays` days before the current day, whether or not the index receives new counts, and it must check for such files at least once a day.
- Dropping an index must delete `_query-counts/<indexName>/`, and discard the counts that the node holds in memory for it, on every node.
- Creating an index under a name that no index holds, by a create or by a restore, must first delete `_query-counts/<indexName>/` on the node that creates it, because a crash during an earlier drop can leave that folder behind.
- Recovery, a checkpoint, a restore without history, and the [Replacing an Index by Restore](durability.md#replacing-an-index-by-restore) steps must leave `_query-counts/` in place. A node must read no key under `_query-counts/` as an index, and a staging prefix never begins with `_`.

The file is a `.nrsl` envelope with the checksum flag set, `envelope_format_version` 1, and no compression, whose payload is this MessagePack map:

```text
QueryCounts {
  day:            string                             (YYYY-MM-DD)
  indexUuid:      string or absent                   (the indexUuid of the index in a cluster, and absent on a single node)
  keyFingerprint: bytes                              (16 bytes)
  savedAt:        uint64                             (milliseconds since the Unix epoch)
  groups:         Map<string, List<PhraseCount>>     (keyed by group)
}

PhraseCount {
  phrase: string          (a normalised phrase)
  count:  uint32
  people: List<bytes>     (scrambled IDs of 16 bytes each, none twice)
}
```

A reader must treat a file as damaged, and skip it, where it fails its checksum or fails to decode, where its `day` differs from its key, where a group or a phrase fails [Phrases](#phrases) under the ceilings of the setting's ranges, where a phrase appears twice in one group, where `people` holds more entries than `count` or more than 4,096 entries, and where a scrambled ID is not 16 bytes. It must skip a file whose `keyFingerprint` differs from the fingerprint of the node's key. In a cluster, it must skip a file whose `indexUuid` is absent or differs from the `indexUuid` that the coordinator holds for the index, and the node must delete that file, so that the counts of a dropped index never reach an index that a caller later creates under the same name. It must tell the operator about each file that it skips.

A writer must keep a history file at or below 16,777,216 bytes, header included, which the ceilings of [Memory](#memory) keep it under, and a reader must treat a longer file as damaged before it reads the file.

A restore that holds history writes each restored file to `_query-counts/<indexName>/restored/<day>-<n>.nrsl`, where `<n>` numbers the files of one day from 0 and is zero-padded to 4 digits, so that a restored file never replaces a file of the counts that the node made. Every rule of this section that applies to `<day>.nrsl` applies to these files too.

A single node stores the outcome of the last build at `_query-counts/<indexName>/build.nrsl`, an envelope with the checksum flag set and `envelope_format_version` 1 whose payload is the [BuildRecord](distribution/cluster.md#query-suggestions-state) that a cluster stores under its coordinator key. The node writes it with an [atomic write](durability.md#atomic-write) when a build ends, and a [build](#building) reads it to decide whether it can skip.

---

## Building

A build turns the history of an index into the documents of its suggestions indexes.

1. **Skip.** The node must skip the build and report `skipped` where another build of the index is in progress, and where no history file is new, changed, or expired since the last build that completed, so that a closed index stays closed. The node decides that by comparing the `sourcesDigest` of the files that it would merge with that of the last completed build, as [Query Suggestions State](distribution/cluster.md#query-suggestions-state) defines.
2. **Read.** On a single node, the node reads every history file of the index and the counts of the current day from memory. In a cluster, the node that holds the controller lease reads every node's files with [suggestions.counts](distribution/transport.md#suggestionscounts). Where the node can't read the history folder, it must end the build as `failed`.
3. **Merge.** For each group, the node merges every file that it read and that it didn't skip, as [History](#history) defines, and ignores each file that has expired. A phrase's `count` is the sum of its counts, and its people are the union of its `people`. The union counts each scrambled ID once, so a person who searched on three nodes counts as one person towards `minPeople`. The union of one phrase holds at most `minPeople` IDs, because a phrase with that many is due whatever the rest hold. The node reads the files in the order of [sourcesDigest](distribution/cluster.md#query-suggestions-state), by node ID and then by key, so that every implementation merges the same files in the same order. The merge holds at most `maxMergePhrases` phrases across every group, and once it holds that many, the node discards each new phrase that a later file brings. The merge also holds at most `maxGroups` groups: it keeps every group that holds a suggestions index whose marker names the index, and once it holds `maxGroups` groups, the node discards each new group that a later file brings, because in a cluster each node admits groups by the history on that node alone. A node should merge in a separate worker whose memory it limits to `mergeMemoryBytes`, and it must end the build as `failed` where that worker fails.
4. **Choose.** A phrase is due where its people number at least `minPeople`, where the ban list doesn't hold it, and where a search of the index with the phrase as its term, over `fields`, with every word required to match, matches at least `minResults` documents. The node must run at most `resultChecksPerSecond` of those searches each second, so that the searches of callers keep their latency.
5. **Write.** For each group, the node writes the differences between the due phrases and the documents of the group's suggestions index whose `origin` is `popular`: it inserts each new phrase, updates each phrase whose `count` changed, and removes each phrase that is no longer due. It leaves every document whose `origin` is `manual` in place, unless the ban list holds it.

The node must remove no document at step 5, and only insert and update, while any of these holds:

- In a cluster, a registered node gave no answer to `suggestions.counts`, which covers a node whose specification version lies below 1.4.
- The oldest history file that the node read lies fewer than `retentionDays` days before the current day, because the history then covers less than its period, as on a node that a caller has just restored.

Where the build fails at any step, the node must leave every suggestions index as it was before step 5, and report `failed`.

### Schedule

`schedule` holds five fields separated by spaces: minute (0 to 59), hour (0 to 23), day of month (1 to 31), month (1 to 12), and day of week (0 to 6, where 0 is Sunday). Each field is `*`, a number, a range `a-b`, a list of those joined by `,`, or any of them followed by `/step`. A day matches where its day of month or its day of week matches, where both fields hold something other than `*`, and where both match otherwise. The node evaluates the fields in `timeZone`, and a time that a daylight saving change skips never matches.

The node must start a build at each time that the schedule matches. Where the node was down at the latest such time, and no build has completed since, it must start one build once it starts. In a cluster, only the node that holds the controller lease starts a scheduled build, and a node that takes over the lease applies the same rule. A caller can also start a build at any time.

A node must report, for each index with the feature on, when the last build started and ended, its outcome, and when the schedule next matches.

---

## The Suggestions Index

Each group of an index has one suggestions index, named `<indexName>.suggestions.<group>`, so that a copy of the index restored under another name builds separate suggestions. A build creates the index where it is absent, as an ordinary index with:

- the schema `{ query: 'string', count: 'number', origin: 'enum' }`
- one partition
- an empty literal stop word set, because a default stop word list can leave a phrase such as 'the who' with no term to match
- the language of the source index, which each build applies again, so that a change of the source's language applies to the suggestions
- the marker `{ index: <indexName>, group: <group> }`, which the index metadata, the index configuration payload, and `IndexSettings` hold as `querySuggestionsSource`

An index name can hold `.`, so a caller can create an index of that name by hand. A build must refuse to write into an index of that name whose marker is absent or names another index or group, and it must then end as `failed` and tell the operator. Only a build creates a marker, and no other write changes it.

Dropping an index must first drop every suggestions index whose marker names it, whatever that index's name is, and then the index itself, so that no derived search text outlives the index. Creating an index under a name that no index holds, by a create or by a restore, must first drop every index whose marker names that name, because a build that is in progress during a drop can create a suggestions index after the drop removed it.

Each document's ID is the normalised phrase, `query` holds the phrase, `count` holds its count, and `origin` is `popular` for a document that a build writes and `manual` for one that a caller adds. An app finds suggestions for what a person types with `{ term, prefix: true, termMatch: 'all', sort: { count: 'desc' } }`.

A caller can add a document with `origin` `manual`. A node must refuse to add a banned phrase with `CONFIG_INVALID`.

---

## Snapshots and Restores

A [snapshot archive](durability.md#snapshot-archive) holds history only where the caller asks for it, because a backup that holds history can keep raw searches after `retentionDays`. Such an archive ends with one entry for each history file of the index that the node holds, its restored files included, after every file that the manifest lists. The entries are named `query-history/0`, `query-history/1`, and so on in decimal, in day order, and each one holds a whole history file as [History](#history) defines it. A node must write those entries one file at a time, so that it never holds the history of an index in memory, which at the ceilings of [The Setting](#the-setting) can pass 4 GB for one node.

A reader must accept `query-history` entries only after every file that the manifest lists, numbered from 0 with no gap, and it must refuse an entry longer than the limit that [History](#history) sets before it reads the entry. A restore uses the history only where the restored index has the feature on and the node holds a key, so that a node stores no search text for an index with the feature off. It then drops each file whose day has expired, skips each file that [History](#history) treats as damaged, which covers a file under another key, and writes the rest as restored files, each with `indexUuid` set to that of the restored index in a cluster and absent on a single node. A restore that holds history replaces the index's history: the node deletes `_query-counts/<indexName>/` and discards the counts of the current day that it holds in memory for the index, before it writes the restored files. The node writes them only once the restore has created or replaced the index, so that a restore that fails changes no history. A restore without history leaves both in place.

A restore must keep a ban through every restore on the same node:

- A restore of an index over an existing index of that name must take the union of the two ban lists.
- Before a restored index serves its first request, the node must remove each phrase of the source index's ban list from every suggestions index whose marker names that source, whether the restore replaced the source or a suggestions index.

A restore on a node that holds no copy of the source keeps the ban list that the archive holds, so a ban that a caller added after the snapshot is lost there.

---

## In a Cluster

`IndexSettings` holds `querySuggestions`, `bannedQueries`, and `querySuggestionsSource`. A node changes the first two with compareAndSet on the index metadata, and every other write of the index metadata must keep all three unchanged.

- Any node counts the searches that it receives, in its history folder, whether or not it holds a copy of the index.
- Only the node that holds the controller lease builds. A node that receives a request for a build sends [suggestions.build](distribution/transport.md#suggestionsbuild) to the controller.
- The controller stores the outcome of each build under the coordinator key `_narsil/query-suggestions/{indexName}/build`, so that a node that takes over the lease finds the last build.
- When its metadata watch delivers the deletion of an index, or a setting with the feature off, each node must delete that index's history folder and discard the counts that it holds in memory for the index. When it starts, a node must do the same for each folder under `_query-counts/` whose index the coordinator no longer holds, or holds with the feature off, so that a node that was down applies the change.
- Dropping an index first drops every suggestions index whose marker names it, through the [Index Deletion Flow](distribution/cluster.md#index-deletion-flow) of each one.
- A [backup](distribution/backups.md) holds history only where the caller asks for it. The controller then reads every node's files with `suggestions.counts` and stores each one as a stored file that the manifest's `queryHistory` lists. A restore of that backup writes those files to the controller's history folder under the new index name, under the rules of [Snapshots and Restores](#snapshots-and-restores).

A cluster node that loses its disk for good loses its counts, and a person who reaches two nodes on one day can count twice towards a phrase's `count`, although once towards `minPeople`.

---

## Error Codes

| Code | Raised when |
|------|-------------|
| `QUERY_SUGGESTIONS_NOT_ENABLED` | A caller records a count for, builds, or previews the suggestions of an index with the feature off, or records a count on a server that has no way to name the person. |
