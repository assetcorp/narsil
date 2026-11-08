#include "regions.h"

#include "../../include/narsil_analysis.h"
#include "../../include/narsil_core.h"
#include "../../include/narsil_segments.h"
#include "../analysis/text.h"

#include <stddef.h>
#include <stdint.h>

static int valid_text(const narsil_tokens *tokens, uint32_t start, uint32_t length) {
  if (length > NARSIL_MAX_ANALYSED_UNITS || start > tokens->unit_count || length > tokens->unit_count - start) {
    return 0;
  }
  size_t end = (size_t)start + length;
  for (size_t position = start; position < end; position++) {
    uint16_t unit = tokens->units[position];
    if (unit < NARSIL_HIGH_SURROGATE_FIRST || unit >= NARSIL_SURROGATE_END) { continue; }
    if (unit >= NARSIL_LOW_SURROGATE_FIRST || ++position == end) { return 0; }
    uint16_t low = tokens->units[position];
    if (low < NARSIL_LOW_SURROGATE_FIRST || low >= NARSIL_SURROGATE_END) { return 0; }
  }
  return 1;
}

int segment_valid_tokens(const segment_regions *regions, const narsil_tokens *tokens) {
  if ((uintptr_t)tokens->tokens % _Alignof(narsil_token) != 0 || (uintptr_t)tokens->units % _Alignof(uint16_t) != 0 ||
      !segment_region_input(regions, tokens->tokens, tokens->token_count, sizeof *tokens->tokens) ||
      !segment_region_input(regions, tokens->units, tokens->unit_count, sizeof *tokens->units)) {
    return 0;
  }
  for (size_t index = 0; index < tokens->token_count; index++) {
    const narsil_token *token = tokens->tokens + index;
    if (!valid_text(tokens, token->term_offset, token->term_length) ||
        (token->surface_offset != NARSIL_NO_SURFACE &&
         !valid_text(tokens, token->surface_offset, token->surface_length))) {
      return 0;
    }
  }
  return 1;
}

narsil_status segment_request_regions(segment_regions *regions, const narsil_index_terms_request *request,
                                      size_t *token_count) {
  if (request == NULL || (uintptr_t)request % _Alignof(narsil_index_terms_request) != 0 ||
      !segment_write_regions(regions, request->segment) ||
      !segment_region_input(regions, request, 1, sizeof *request) ||
      request->ordinal >= request->segment->ordinal_capacity || request->field_count > request->segment->field_count ||
      (uintptr_t)request->fields % _Alignof(narsil_field_tokens) != 0 ||
      !segment_region_input(regions, request->fields, request->field_count, sizeof *request->fields)) {
    return NARSIL_INVALID_ARGUMENT;
  }
  size_t count = 0;
  for (size_t index = 0; index < request->field_count; index++) {
    const narsil_field_tokens *field = request->fields + index;
    if (field->field >= request->segment->field_count ||
        (index > 0 && field->field <= request->fields[index - 1].field) ||
        !segment_valid_tokens(regions, &field->tokens) || field->tokens.token_count > SIZE_MAX - count) {
      return NARSIL_INVALID_ARGUMENT;
    }
    count += field->tokens.token_count;
  }
  *token_count = count;
  return NARSIL_OK;
}
