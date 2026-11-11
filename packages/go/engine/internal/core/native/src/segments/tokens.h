#ifndef NARSIL_SEGMENT_TOKENS_H
#define NARSIL_SEGMENT_TOKENS_H

#include "../../include/narsil_core.h"
#include "../../include/narsil_segments.h"
#include "strings.h"

#include <stddef.h>
#include <stdint.h>

typedef struct {
  uint32_t term;
  uint32_t position;
  uint16_t field;
} segment_token_ref;

typedef struct {
  segment_strings terms;
  segment_strings surfaces;
  segment_strings spellings;
  segment_token_ref *tokens;
  size_t capacity;
  size_t count;
} segment_token_plan;

narsil_status segment_tokens_prepare(segment_token_plan *plan, const narsil_index_terms_request *request,
                                     size_t token_count);
narsil_status segment_tokens_for_removal(segment_token_plan *plan, const narsil_index_terms_request *request,
                                         size_t token_count);
void segment_tokens_release(segment_token_plan *plan);
size_t segment_tokens_bytes(const segment_token_plan *plan);

#endif
