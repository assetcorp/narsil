---
status: accepted
---

# Field options are part of the type name, so an older Narsil raises an error in place of serving a partial index

A field's options follow its base type in the type name, separated by colons in any order, as in `string:sortable:pattern:partial`. Every implementation stores the options in one fixed order so that the stored type name of a field is the same whatever order the caller writes them in. The options for `string` and `string[]` are `sortable`, `pattern`, and `partial`. The only option for `verbatim` and `verbatim[]` is `sortable`, because the engine always builds a pattern index for a verbatim field and never splits its value into words.

With pattern search, Narsil gains a `verbatim` type and two options for text fields. A caller can want all three of sorting, pattern search, and partial-word search on one product title. When we made this decision, Narsil recognised `string:sortable` as one exact name, with no way to add a second option. An object in a schema already describes a group of nested fields, so the engine can tell a settings object on a field from a group of nested fields only through a reserved key, and storing those objects changes the format of every stored schema. In every stored schema, each field's type is one string, so adding options to the type name changes nothing in the file format.

The main reason for this shape is the behaviour of older versions. The spec lets an older reader ignore a stored setting that it does not know, so where options are separate settings, an older Narsil can open the index and serve it without the options. With the options in the type name, the whole type is unknown to the older reader, so it raises an error under the rule that ADR 0012 records.

A query can sort by a list only where the list's type includes `sortable`, as with a single field, because the engine spends the same memory per document to order a list of text. When we made this decision, a `string[]` field sorted with no marker, so this rule changes how an existing index behaves. We change it now, because Narsil is before 1.0.

The engine raises an error for `partial` on an index with `surfaceForms` set to false, because the engine matches partial words against the written spelling of each word, which it records only while `surfaceForms` is on. An implementation parses each type name when the index opens so that the engine compares no type strings while it indexes each document.

## Considered options

A settings object on each field, or a list of fields per option at the index level, matches the shapes that some established engines use. Under the spec's rule for unknown settings, however, an older Narsil can serve the index without those settings, as described above. An `enum:pattern` option adds the pattern index to the enum type, but for an enum field the engine keeps a JavaScript `Set` for every distinct value and stores every value a second time, so it stores a field of unique log lines twice. Leaving `string[]` sortable with no marker keeps today's behaviour, but then the engine applies the memory opt-in to single text fields alone.

## Consequences

The spec will gain the `verbatim` and `verbatim[]` types, the three options, and their fixed order. Every check in the code that compares a type string with `string` or `string:sortable` has to compare the parsed base type and options. The engine raises `SCHEMA_INVALID_TYPE` for an unknown option and for an option written twice, as it does today for an unknown type. An index that sorts a `string[]` field today has to add `sortable` to that field's type.
