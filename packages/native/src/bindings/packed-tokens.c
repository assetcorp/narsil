#include "../../include/narsil_packed_tokens.h"

#include "../../include/narsil_analysis.h"
#include "../../include/narsil_core.h"
#include "../regions.h"

#include <stddef.h>
#include <stdint.h>
#include <string.h>

enum {
  POSITION,
  TERM_OFFSET,
  TERM_LENGTH,
  SURFACE_OFFSET,
  SURFACE_LENGTH,
  ORIGINAL_OFFSET,
  ORIGINAL_LENGTH,
  TERM_SLOT,
  TOKEN_WORDS
};
enum { INPUT_REGIONS = 3, OUTPUT_REGIONS = 3 };

static int valid_regions(const narsil_tokens *tokens, uint32_t *records, size_t capacity, uint16_t *units,
                         size_t unit_capacity, uint32_t *unit_count) {
  memory_region inputs[INPUT_REGIONS];
  memory_region outputs[OUTPUT_REGIONS];
  if (tokens == NULL || (uintptr_t)tokens % _Alignof(narsil_tokens) != 0 ||
      (uintptr_t)tokens->tokens % _Alignof(narsil_token) != 0 || (uintptr_t)tokens->units % _Alignof(uint16_t) != 0 ||
      capacity == 0 || (uintptr_t)records % _Alignof(uint32_t) != 0 || (uintptr_t)units % _Alignof(uint16_t) != 0 ||
      (uintptr_t)unit_count % _Alignof(uint32_t) != 0 || !region_of(tokens, 1, sizeof *tokens, &inputs[0]) ||
      !region_of(tokens->tokens, tokens->token_count, sizeof *tokens->tokens, &inputs[1]) ||
      !region_of(tokens->units, tokens->unit_count, sizeof *tokens->units, &inputs[2]) ||
      !region_of(records, capacity, sizeof *records, &outputs[0]) ||
      !region_of(units, unit_capacity, sizeof *units, &outputs[1]) ||
      !region_of(unit_count, 1, sizeof *unit_count, &outputs[2])) {
    return 0;
  }
  for (size_t at = 0; at < OUTPUT_REGIONS; at++) {
    for (size_t input = 0; input < INPUT_REGIONS; input++) {
      if (overlaps(outputs[at], inputs[input])) { return 0; }
    }
    for (size_t other = 0; other < at; other++) {
      if (overlaps(outputs[at], outputs[other])) { return 0; }
    }
  }
  return 1;
}

narsil_status narsil_pack_tokens(const narsil_tokens *tokens, uint32_t *records, size_t capacity, uint16_t *units,
                                 size_t unit_capacity, uint32_t *unit_count) {
  if (!valid_regions(tokens, records, capacity, units, unit_capacity, unit_count)) { return NARSIL_INVALID_ARGUMENT; }
  uint32_t start = tokens->unit_count;
  for (uint32_t at = 0; at < tokens->token_count; at++) {
    const narsil_token *token = tokens->tokens + at;
    if (token->term_offset > tokens->unit_count || token->term_length > tokens->unit_count - token->term_offset) {
      return NARSIL_INVALID_ARGUMENT;
    }
    if (token->term_offset < start) { start = token->term_offset; }
    if (token->surface_offset == NARSIL_NO_SURFACE) { continue; }
    if (token->surface_offset > tokens->unit_count ||
        token->surface_length > tokens->unit_count - token->surface_offset) {
      return NARSIL_INVALID_ARGUMENT;
    }
    if (token->surface_offset < start) { start = token->surface_offset; }
  }
  uint32_t needed = tokens->unit_count - start;
  records[0] = tokens->token_count;
  *unit_count = needed;
  if (tokens->token_count > (capacity - 1) / TOKEN_WORDS || needed > unit_capacity) { return NARSIL_NEEDS_ROOM; }
  if (needed > 0) { memcpy(units, tokens->units + start, (size_t)needed * sizeof *units); }
  for (uint32_t at = 0; at < tokens->token_count; at++) {
    const narsil_token *token = tokens->tokens + at;
    uint32_t *record = records + 1 + ((size_t)at * TOKEN_WORDS);
    record[POSITION] = token->position;
    record[TERM_OFFSET] = token->term_offset - start;
    record[TERM_LENGTH] = token->term_length;
    record[SURFACE_OFFSET] =
        token->surface_offset == NARSIL_NO_SURFACE ? NARSIL_NO_SURFACE : token->surface_offset - start;
    record[SURFACE_LENGTH] = token->surface_length;
    record[ORIGINAL_OFFSET] = 0;
    record[ORIGINAL_LENGTH] = 0;
    record[TERM_SLOT] = NARSIL_NO_TERM_SLOT;
  }
  return NARSIL_OK;
}
