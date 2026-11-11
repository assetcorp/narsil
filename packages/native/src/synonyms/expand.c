#include "internal.h"

#include "../../include/narsil_core.h"
#include "../../include/narsil_synonyms.h"

#include <stddef.h>
#include <stdint.h>
#include <string.h>

typedef struct {
  uint32_t query;
  uint32_t length;
  uint32_t tokens[SYNONYM_BUDGET];
} synonym_group;

static int valid_table(const narsil_synonym_request *request) {
  const narsil_synonym_table *table = request->table;
  if (!synonym_offsets(table->offsets, table->token_count, table->token_bytes) ||
      !synonym_offsets(table->rule_start, table->rule_count, table->rule_token_count) ||
      !synonym_offsets(table->token_start, table->token_count, table->token_rule_count) ||
      !synonym_offsets(request->starts, request->query_count, request->unit_count)) {
    return 0;
  }
  for (size_t rule = 0; rule < table->rule_count; rule++) {
    int32_t source = table->rule_source[rule];
    if (source < -1 || (source >= 0 && (uint32_t)source >= table->token_count)) { return 0; }
  }
  for (size_t at = 0; at < table->rule_token_count; at++) {
    if (table->rule_tokens[at] >= table->token_count) { return 0; }
  }
  for (size_t at = 0; at < table->token_rule_count; at++) {
    if (table->token_rules[at] >= table->rule_count) { return 0; }
  }
  return 1;
}

static void add_token(synonym_group *group, uint32_t token) {
  size_t position = 0;
  while (position < group->length && group->tokens[position] < token) { position++; }
  if (position == SYNONYM_BUDGET || (position < group->length && group->tokens[position] == token)) { return; }
  size_t end = group->length < SYNONYM_BUDGET ? group->length++ : SYNONYM_BUDGET - 1;
  while (end > position) {
    group->tokens[end] = group->tokens[end - 1];
    end--;
  }
  group->tokens[position] = token;
}

static int already_taken(const narsil_synonym_request *request, uint32_t query, const synonym_group *groups,
                         size_t count) {
  uint32_t start = request->starts[query];
  size_t length = request->starts[(size_t)query + 1] - start;
  for (size_t at = 0; at < count; at++) {
    uint32_t other = request->starts[groups[at].query];
    if (request->starts[(size_t)groups[at].query + 1] - other == length &&
        (length == 0 || memcmp(request->units + start, request->units + other, length * sizeof *request->units) == 0)) {
      return 1;
    }
  }
  return 0;
}

static narsil_status collect_token(const narsil_synonym_table *table, synonym_group *group, uint32_t token) {
  for (size_t at = table->token_start[token]; at < table->token_start[(size_t)token + 1]; at++) {
    uint32_t rule = table->token_rules[at];
    int32_t source = table->rule_source[rule];
    if (source >= 0 && (uint32_t)source != token) { return NARSIL_INVALID_ARGUMENT; }
    int holds_token = source >= 0;
    for (size_t entry = table->rule_start[rule]; entry < table->rule_start[(size_t)rule + 1]; entry++) {
      uint32_t added = table->rule_tokens[entry];
      if (added == token) { holds_token = 1; }
      if (added != token) { add_token(group, added); }
    }
    if (!holds_token) { return NARSIL_INVALID_ARGUMENT; }
  }
  return NARSIL_OK;
}

static narsil_status collect(const narsil_synonym_request *request, synonym_group groups[SYNONYM_BUDGET],
                             uint32_t *count) {
  const narsil_synonym_table *table = request->table;
  *count = 0;
  for (uint32_t query = 0; query < request->query_count && *count < SYNONYM_BUDGET; query++) {
    if (already_taken(request, query, groups, *count)) { continue; }
    int64_t rank = synonym_rank(request, query);
    if (rank == -2) { return NARSIL_INVALID_ARGUMENT; }
    if (rank < 0) { continue; }
    uint32_t token = (uint32_t)rank;
    synonym_group *group = groups + *count;
    *group = (synonym_group){.query = query};
    narsil_status status = collect_token(table, group, token);
    if (status != NARSIL_OK) { return status; }
    if (group->length > 0) { (*count)++; }
  }
  return NARSIL_OK;
}

narsil_status narsil_expand_synonyms(const narsil_synonym_request *request, const narsil_synonym_output *output,
                                     uint32_t *count) {
  if (!synonym_regions(request, output, count) || !valid_table(request)) { return NARSIL_INVALID_ARGUMENT; }
  synonym_group groups[SYNONYM_BUDGET];
  uint32_t held = 0;
  narsil_status status = collect(request, groups, &held);
  if (status != NARSIL_OK) { return status; }
  size_t needed = 0;
  for (uint32_t at = 0; at < held; at++) {
    uint32_t quota = (SYNONYM_BUDGET / held) + (at < SYNONYM_BUDGET % held);
    if (groups[at].length > quota) { groups[at].length = quota; }
    needed += groups[at].length;
  }
  if (output->query_capacity < held || output->start_capacity < (size_t)held + 1 || output->token_capacity < needed) {
    return NARSIL_NEEDS_ROOM;
  }
  uint32_t cursor = 0;
  for (uint32_t at = 0; at < held; at++) {
    output->queries[at] = groups[at].query;
    output->starts[at] = cursor;
    memcpy(output->tokens + cursor, groups[at].tokens, groups[at].length * sizeof *output->tokens);
    cursor += groups[at].length;
  }
  output->starts[held] = cursor;
  *count = held;
  return NARSIL_OK;
}
