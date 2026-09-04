# Working on a language

Run every command below from the repository root. Continuous integration runs the checks
marked enforced on every push, so it catches a step you skip before a release does.

| Command | What it does | Run it when | Enforced |
| --- | --- | --- | --- |
| `pnpm nx run narsil-ts:revisions` | Compares each module's analysis against `packages/ts/languages.lock.json` | You change anything under `src/languages/` or `src/core/tokenizer/` | Yes |
| `pnpm nx run narsil-ts:revisions:write` | Bumps each changed revision and rewrites the lock file | The check above failed | No |
| `pnpm nx run narsil-ts:lookalikes` | Checks that the tokenizer maps every letter substituted past the bar onto the letter it stands in for | You change a module's tokenizer or normalizer | Yes |
| `pnpm nx run narsil-ts:lookalikes:collect` | Measures substitutions against fresh Wikipedia articles and rewrites `packages/ts/languages.lookalikes.json` | You add a language whose alphabet has lookalike letters | No |
| `pnpm nx run narsil-ts:stemmers` | Regenerates every Snowball stemmer and checks it against the published word pairs | You change `snowball/build.ts`, `snowball/base-stemmer.ts`, or a generated stemmer | Yes |

`revisions:write`, `lookalikes:collect`, and `stemmers` write files you then commit.
`lookalikes:collect` and `stemmers` fetch over the network. The other three read the
repository alone, and the repository stores no fetched text.

## Changing an existing language

Edit the module, then run `narsil-ts:revisions`. It fails when you changed the analysis and
left the revision alone:

```text
greek: analysis changed while revision stayed 4f02e255d00e5848
```

Run `narsil-ts:revisions:write` and read the diff. On startup an engine compares the stored
revision against the one its own module declares, and rebuilds the index in the background
when the two differ, so it rebuilds a stored index only after you bump.

Adding or removing a stop word counts, and so does editing the normalizer or a tokenizer
field. Editing a generated stemmer or the shared Snowball runtime counts too, because the
check digests every local file the module imports. A comment edit or a reformat changes
nothing.

## Changing the shared tokenizer

`src/core/tokenizer/` splits, folds, and stems the text for every language. The check digests
the implementation alongside each module's own sources and reports the two cases apart:

```text
src/core/tokenizer/ changed, so every language analyses text differently: 107 revisions must bump
greek: analysis changed while revision stayed 4f02e255d00e5848
```

`revisions:write` then bumps all 107 revisions in one go, which is the correct result when
the analysis changed because every stored index holds terms the old code produced. The
digest includes analysis constants such as `DEFAULT_MIN_TOKEN_LENGTH`, but excludes cache
sizes and host-memory thresholds. Those values change resource use, not the terms an index
stores, so changing them must not rebuild every stored index.

## Adding a language

1. Write `src/languages/<name>.ts`. Copy the closest existing module for the shape, and open
   the file with a comment naming the source of the stop word list and its licence. Where no
   published list exists, say so and name what you curated the list from.
2. Write `src/__tests__/languages/fixtures/<name>.ts` and add it to `fixtures/index.ts`. The
   coverage gate requires at least two published samples with a source each, at least one
   word that must stay whole, at least one phrase that must split, and at least one query
   that must retrieve a document. Copy each sample verbatim from the fetched page instead of
   typing it, because hand-typed text reorders combining marks.
3. Run `narsil-ts:test`. The coverage gate fails until the fixture exists, and the
   orthography gate fails when the tokenizer drops a character the samples use.
4. Run `narsil-ts:revisions:write` to record the new module in the lock file. A new language
   keeps the revision `1`, and the tool only records its fingerprint.
5. When the alphabet has a letter with a common lookalike, add it to the table in
   `scripts/lookalike-counts.ts` and run `narsil-ts:lookalikes:collect`. Add a fold only when
   the count clears the bar below, and record the count either way.

## The lookalike bar

Some alphabets use letters that published text substitutes with a lookalike: Ewe's `ɖ` typed
as Icelandic `ð`, Samoan's `ʻ` typed as a curly quote, Kazakh's `і` typed as Latin `i`. The
record in `languages.lookalikes.json` names the Wikipedia revision behind every count, so
anyone can re-run the measurement and get the same numbers.

Add a fold at 139 substitutions against 51 correct, the count behind the first one. Below
that, treat the substitution as a typo and add no fold. For a Cyrillic language the counter
reads mixed-script words instead of single characters, because Cyrillic prose uses Latin
names and codes legitimately.

## The rest of the rules

`AGENTS.md` at the repository root holds the house rules for this package.
