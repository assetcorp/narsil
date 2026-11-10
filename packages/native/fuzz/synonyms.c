#include "input.h"

#include "../include/narsil_synonyms.h"

#include <stddef.h>
#include <stdint.h>

enum {
  LETTERS = 4,
  WORDS_PER_LETTER = LETTERS + 1,
  WORD_UNIVERSE = LETTERS * WORDS_PER_LETTER,
  MAX_WORD_UNITS = 2,
  MAX_RULES = 12,
  MAX_RULE_TOKENS = 6,
  MAX_QUERIES = 10,
  MAX_OUTPUT = 64,
  FIRST_LETTER = 'a',
  QUERY_LETTERS = LETTERS + 1,
  SURROGATE_FIRST = 0xD800
};

typedef struct {
  uint8_t *tokens;
  uint32_t *offsets;
  size_t token_count;
  size_t token_bytes;
} token_list;

static size_t word_letters(uint32_t word, uint8_t letters[MAX_WORD_UNITS]) {
  uint32_t within = word % WORDS_PER_LETTER;
  letters[0] = (uint8_t)(FIRST_LETTER + (word / WORDS_PER_LETTER));
  if (within == 0) { return 1; }
  letters[1] = (uint8_t)(FIRST_LETTER + within - 1);
  return MAX_WORD_UNITS;
}

static token_list sorted_tokens(fuzz_input *input) {
  uint32_t chosen = fuzz_u32(input);
  token_list list = {NULL, NULL, 0, 0};
  for (uint32_t word = 0; word < WORD_UNIVERSE; word++) {
    if (((chosen >> word) & 1U) == 0) { continue; }
    uint8_t letters[MAX_WORD_UNITS];
    list.token_count++;
    list.token_bytes += word_letters(word, letters);
  }
  list.tokens = FUZZ_ROOM(input, uint8_t, list.token_bytes);
  list.offsets = FUZZ_ROOM(input, uint32_t, list.token_count + 1);
  if (input->exhausted_memory) { return list; }
  size_t token = 0;
  size_t written = 0;
  for (uint32_t word = 0; word < WORD_UNIVERSE; word++) {
    if (((chosen >> word) & 1U) == 0) { continue; }
    uint8_t letters[MAX_WORD_UNITS];
    size_t length = word_letters(word, letters);
    list.offsets[token++] = (uint32_t)written;
    for (size_t at = 0; at < length; at++) { list.tokens[written++] = letters[at]; }
  }
  list.offsets[token] = (uint32_t)written;
  return list;
}

static token_list raw_tokens(fuzz_input *input) {
  token_list list = {NULL, NULL, fuzz_below(input, WORD_UNIVERSE + 1), fuzz_below(input, MAX_OUTPUT + 1)};
  list.tokens = FUZZ_ARRAY(input, uint8_t, list.token_bytes);
  list.offsets = fuzz_offsets(input, list.token_count, (uint32_t)list.token_bytes);
  return list;
}

static int offsets_ascend(const uint32_t *offsets, size_t count, size_t total) {
  if (offsets[0] != 0 || offsets[count] != total) { return 0; }
  for (size_t at = 1; at <= count; at++) {
    if (offsets[at] < offsets[at - 1]) { return 0; }
  }
  return 1;
}

static int rule_holds(size_t rule, const narsil_synonym_table *table, uint32_t token) {
  for (size_t at = table->rule_start[rule]; at < table->rule_start[rule + 1]; at++) {
    if (table->rule_tokens[at] == token) { return 1; }
  }
  return 0;
}

static int rule_opens(size_t rule, const narsil_synonym_table *table, uint32_t token) {
  int32_t source = table->rule_source[rule];
  return source < 0 ? rule_holds(rule, table, token) : (uint32_t)source == token;
}

static void shape_rules(fuzz_input *input, narsil_synonym_table *table, uint32_t *rule_tokens, int32_t *rule_source) {
  for (size_t at = 0; at < table->rule_token_count; at++) { rule_tokens[at] %= (uint32_t)table->token_count; }
  for (size_t rule = 0; rule < table->rule_count; rule++) {
    uint32_t start = table->rule_start[rule];
    uint32_t length = table->rule_start[rule + 1] - start;
    int one_way = length > 0 && (fuzz_byte(input) & 1U) == 1U;
    rule_source[rule] = one_way ? (int32_t)rule_tokens[start + fuzz_below(input, length)] : -1;
  }
}

static void index_rules(fuzz_input *input, narsil_synonym_table *table) {
  size_t count = 0;
  for (uint32_t token = 0; token < table->token_count; token++) {
    for (size_t rule = 0; rule < table->rule_count; rule++) { count += (size_t)rule_opens(rule, table, token); }
  }
  uint32_t *token_start = FUZZ_ROOM(input, uint32_t, table->token_count + 1);
  uint32_t *token_rules = FUZZ_ROOM(input, uint32_t, count);
  if (input->exhausted_memory) { return; }
  size_t written = 0;
  for (uint32_t token = 0; token < table->token_count; token++) {
    token_start[token] = (uint32_t)written;
    for (size_t rule = 0; rule < table->rule_count; rule++) {
      if (rule_opens(rule, table, token)) { token_rules[written++] = (uint32_t)rule; }
    }
  }
  token_start[table->token_count] = (uint32_t)written;
  table->token_start = token_start;
  table->token_rules = token_rules;
  table->token_rule_count = count;
}

static narsil_synonym_table fuzz_table(fuzz_input *input) {
  int loose = fuzz_raw(input);
  token_list list = loose ? raw_tokens(input) : sorted_tokens(input);
  narsil_synonym_table table = {
      list.tokens, list.token_bytes, list.offsets, list.token_count, NULL, NULL, 0, NULL, 0, NULL, NULL, 0};
  table.rule_count = list.token_count == 0 ? 0 : fuzz_below(input, MAX_RULES + 1);
  table.rule_token_count = table.rule_count == 0 ? 0 : fuzz_below(input, (MAX_RULES * MAX_RULE_TOKENS) + 1);
  table.rule_start = fuzz_offsets(input, table.rule_count, (uint32_t)table.rule_token_count);
  int32_t *rule_source = FUZZ_ARRAY(input, int32_t, table.rule_count);
  uint32_t *rule_tokens = FUZZ_ARRAY(input, uint32_t, table.rule_token_count);
  table.rule_source = rule_source;
  table.rule_tokens = rule_tokens;
  if (input->exhausted_memory) { return table; }
  if (loose || fuzz_raw(input) || !offsets_ascend(table.rule_start, table.rule_count, table.rule_token_count)) {
    table.token_rule_count = fuzz_below(input, MAX_OUTPUT + 1);
    table.token_start = fuzz_offsets(input, table.token_count, (uint32_t)table.token_rule_count);
    table.token_rules = FUZZ_ARRAY(input, uint32_t, table.token_rule_count);
    return table;
  }
  shape_rules(input, &table, rule_tokens, rule_source);
  index_rules(input, &table);
  return table;
}

static uint16_t query_unit(fuzz_input *input) {
  uint8_t drawn = fuzz_byte(input);
  if (fuzz_raw(input)) { return (uint16_t)(SURROGATE_FIRST | drawn); }
  return (uint16_t)(FIRST_LETTER + (drawn % QUERY_LETTERS));
}

static uint16_t *fuzz_queries(fuzz_input *input, size_t query_count, uint32_t **starts, size_t *unit_count) {
  uint32_t *bounds = FUZZ_ROOM(input, uint32_t, query_count + 1);
  *starts = bounds;
  *unit_count = 0;
  if (bounds == NULL) { return NULL; }
  for (size_t query = 0; query < query_count; query++) {
    bounds[query] = (uint32_t)*unit_count;
    *unit_count += fuzz_below(input, MAX_WORD_UNITS + 1);
  }
  bounds[query_count] = (uint32_t)*unit_count;
  uint16_t *units = FUZZ_ROOM(input, uint16_t, *unit_count);
  for (size_t at = 0; units != NULL && at < *unit_count; at++) { units[at] = query_unit(input); }
  return units;
}

int LLVMFuzzerTestOneInput(const uint8_t *data, size_t size) {
  fuzz_input input = fuzz_begin(data, size);
  narsil_synonym_table table = fuzz_table(&input);
  size_t query_count = fuzz_below(&input, MAX_QUERIES + 1);
  uint32_t *starts = NULL;
  size_t unit_count = 0;
  uint16_t *units = fuzz_queries(&input, query_count, &starts, &unit_count);
  size_t query_capacity = fuzz_below(&input, MAX_QUERIES + 2);
  size_t start_capacity = fuzz_below(&input, MAX_QUERIES + 2);
  size_t token_capacity = fuzz_below(&input, MAX_OUTPUT + 1);
  narsil_synonym_output output = {FUZZ_ROOM(&input, uint32_t, query_capacity), query_capacity,
                                  FUZZ_ROOM(&input, uint32_t, start_capacity), start_capacity,
                                  FUZZ_ROOM(&input, uint32_t, token_capacity), token_capacity};
  uint32_t *count = FUZZ_ROOM(&input, uint32_t, 1);
  if (!input.exhausted_memory) {
    narsil_synonym_request request = {&table, units, unit_count, starts, query_count};
    (void)narsil_expand_synonyms(&request, &output, count);
  }
  fuzz_release(&input);
  return 0;
}
