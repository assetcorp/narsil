#include "internal.h"

#include "../../include/narsil_synonyms.h"
#include "../regions.h"

#include <stddef.h>
#include <stdint.h>

int synonym_regions(const narsil_synonym_request *request, const narsil_synonym_output *output, uint32_t *count) {
  if (request == NULL || output == NULL || (uintptr_t)request % _Alignof(narsil_synonym_request) != 0 ||
      (uintptr_t)output % _Alignof(narsil_synonym_output) != 0 || request->table == NULL ||
      (uintptr_t)request->table % _Alignof(narsil_synonym_table) != 0) {
    return 0;
  }
  const narsil_synonym_table *table = request->table;
  if (table->token_count > (size_t)INT32_MAX + 1 || table->rule_count > UINT32_MAX || table->rule_count == SIZE_MAX ||
      table->token_bytes > UINT32_MAX || table->rule_token_count > UINT32_MAX || table->token_rule_count > UINT32_MAX ||
      request->query_count > UINT32_MAX || request->query_count == SIZE_MAX || request->unit_count > UINT32_MAX) {
    return 0;
  }
  enum { INPUTS = 12, OUTPUTS = 4 };
  const void *inputs[INPUTS] = {request,
                                table,
                                output,
                                table->tokens,
                                table->offsets,
                                table->rule_start,
                                table->rule_source,
                                table->rule_tokens,
                                table->token_start,
                                table->token_rules,
                                request->units,
                                request->starts};
  const size_t lengths[INPUTS] = {1,
                                  1,
                                  1,
                                  table->token_bytes,
                                  table->token_count + 1,
                                  table->rule_count + 1,
                                  table->rule_count,
                                  table->rule_token_count,
                                  table->token_count + 1,
                                  table->token_rule_count,
                                  request->unit_count,
                                  request->query_count + 1};
  const size_t widths[INPUTS] = {sizeof *request,
                                 sizeof *table,
                                 sizeof *output,
                                 sizeof *table->tokens,
                                 sizeof *table->offsets,
                                 sizeof *table->rule_start,
                                 sizeof *table->rule_source,
                                 sizeof *table->rule_tokens,
                                 sizeof *table->token_start,
                                 sizeof *table->token_rules,
                                 sizeof *request->units,
                                 sizeof *request->starts};
  memory_region writes[OUTPUTS];
  if (!region_of(output->queries, output->query_capacity, sizeof *output->queries, &writes[0]) ||
      !region_of(output->starts, output->start_capacity, sizeof *output->starts, &writes[1]) ||
      !region_of(output->tokens, output->token_capacity, sizeof *output->tokens, &writes[2]) ||
      !region_of(count, 1, sizeof *count, &writes[3])) {
    return 0;
  }
  for (size_t at = 0; at < OUTPUTS; at++) {
    if (writes[at].start % _Alignof(uint32_t) != 0) { return 0; }
    for (size_t previous = 0; previous < at; previous++) {
      if (overlaps(writes[at], writes[previous])) { return 0; }
    }
    for (size_t input = 0; input < INPUTS; input++) {
      memory_region read;
      if ((input >= 3 && lengths[input] > 0 && (uintptr_t)inputs[input] % widths[input] != 0) ||
          !region_of(inputs[input], lengths[input], widths[input], &read) || overlaps(read, writes[at])) {
        return 0;
      }
    }
  }
  return 1;
}

int synonym_offsets(const uint32_t *offsets, size_t count, size_t end) {
  if (offsets[0] != 0 || offsets[count] != end) { return 0; }
  for (size_t at = 0; at < count; at++) {
    if (offsets[at] > offsets[at + 1]) { return 0; }
  }
  return 1;
}
