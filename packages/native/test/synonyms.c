#include "fixture.h"

#include "../include/narsil_core.h"
#include "../include/narsil_synonyms.h"

#include <stdint.h>
#include <string.h>

enum { TOKEN_COUNT = 4, RULE_COUNT = 2, QUERY_COUNT = 5, RETURNED_TOKENS = 5, OUTPUT_WORDS = 8, SENTINEL = 77 };

void synonym_checks(void) {
  uint8_t tokens[] = {'a', 'b', 'c', 'd'};
  uint32_t offsets[] = {0, 1, 2, 3, 4};
  uint32_t rule_start[] = {0, 3, 4};
  int32_t sources[] = {-1, 0};
  uint32_t members[] = {2, 0, 1, 3};
  uint32_t token_start[] = {0, 2, 3, 4, 4};
  uint32_t rules[] = {0, 1, 0, 0};
  narsil_synonym_table table = {tokens,     sizeof tokens, offsets,     TOKEN_COUNT, rule_start, sources,
                                RULE_COUNT, members,       TOKEN_COUNT, token_start, rules,      TOKEN_COUNT};
  uint16_t text[] = {'a', 'a', 'd', 'b', 'z'};
  uint32_t starts[] = {0, 1, 2, 3, 4, QUERY_COUNT};
  narsil_synonym_request request = {&table, text, QUERY_COUNT, starts, QUERY_COUNT};
  uint32_t queries[OUTPUT_WORDS];
  uint32_t into_starts[OUTPUT_WORDS];
  uint32_t into_tokens[OUTPUT_WORDS];
  for (size_t at = 0; at < OUTPUT_WORDS; at++) {
    queries[at] = SENTINEL;
    into_starts[at] = SENTINEL;
    into_tokens[at] = SENTINEL;
  }
  narsil_synonym_output output = {queries, OUTPUT_WORDS, into_starts, OUTPUT_WORDS, into_tokens, OUTPUT_WORDS};
  uint32_t count = SENTINEL;
  check(narsil_expand_synonyms(&request, &output, &count) == NARSIL_OK && count == 2 && queries[0] == 0 &&
            queries[1] == 3 && queries[2] == SENTINEL && into_starts[0] == 0 && into_starts[1] == 3 &&
            into_starts[2] == RETURNED_TOKENS && into_tokens[0] == 1 && into_tokens[1] == 2 && into_tokens[2] == 3 &&
            into_tokens[3] == 0 && into_tokens[4] == 2 && into_tokens[RETURNED_TOKENS] == SENTINEL,
        "synonyms deduplicate query tokens and respect one-way rules and token order");
  uint32_t saved_queries[OUTPUT_WORDS];
  uint32_t saved_starts[OUTPUT_WORDS];
  uint32_t saved_tokens[OUTPUT_WORDS];
  memcpy(saved_queries, queries, sizeof queries);
  memcpy(saved_starts, into_starts, sizeof into_starts);
  memcpy(saved_tokens, into_tokens, sizeof into_tokens);
  output.token_capacity = 4;
  count = SENTINEL;
  check(narsil_expand_synonyms(&request, &output, &count) == NARSIL_NEEDS_ROOM && count == SENTINEL &&
            memcmp(saved_queries, queries, sizeof queries) == 0 &&
            memcmp(saved_starts, into_starts, sizeof into_starts) == 0 &&
            memcmp(saved_tokens, into_tokens, sizeof into_tokens) == 0,
        "a short synonym output preserves every region and the group count");
  output.token_capacity = OUTPUT_WORDS;
  members[3] = UINT32_MAX;
  check(narsil_expand_synonyms(&request, &output, &count) == NARSIL_INVALID_ARGUMENT && count == SENTINEL &&
            memcmp(saved_tokens, into_tokens, sizeof into_tokens) == 0,
        "an invalid synonym ordinal refuses before publishing earlier groups");
  members[3] = 3;
  output.queries = offsets;
  output.query_capacity = TOKEN_COUNT + 1;
  check(narsil_expand_synonyms(&request, &output, &count) == NARSIL_INVALID_ARGUMENT && offsets[0] == 0,
        "synonym outputs cannot overwrite dictionary offsets");
  output.queries = queries;
  output.query_capacity = OUTPUT_WORDS;
  output.starts = queries;
  check(narsil_expand_synonyms(&request, &output, &count) == NARSIL_INVALID_ARGUMENT && count == SENTINEL,
        "synonym output regions cannot overlap");
  output.starts = into_starts;
  starts[0] = 1;
  check(narsil_expand_synonyms(&request, &output, &count) == NARSIL_INVALID_ARGUMENT,
        "synonym input validates its first offset");
}
