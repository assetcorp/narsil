#include "../../include/narsil_frozen_segments.h"

#include "../../include/narsil_analysis.h"
#include "../../include/narsil_core.h"
#include "../../include/narsil_segments.h"
#include "frozen.h"

#include <stddef.h>
#include <stdint.h>

enum { FROZEN_WORD_BITS = 32 };

frozen_pending_size frozen_pending_needed(const narsil_remove_frozen_request *request) {
  uint64_t tokens = 0;
  uint64_t units = 0;
  for (size_t at = 0; at < request->field_count; at++) {
    const narsil_field_tokens *field = request->fields + at;
    for (size_t index = 0; index < field->tokens.token_count; index++) {
      const narsil_token *token = field->tokens.tokens + index;
      tokens++;
      units += token->term_length;
      if (token->surface_offset != NARSIL_NO_SURFACE) { units += token->surface_length; }
    }
  }
  return (frozen_pending_size){1, tokens, units};
}

static int pending_fits(const narsil_frozen_segment_state *state, frozen_pending_size needed, int empty) {
  const uint32_t *header = state->pending_header;
  uint64_t documents = (empty ? 0 : (uint64_t)header[NARSIL_PENDING_DOCUMENTS]) + needed.documents;
  uint64_t tokens = (empty ? 0 : (uint64_t)header[NARSIL_PENDING_TOKENS]) + needed.tokens;
  uint64_t units = (empty ? 0 : (uint64_t)header[NARSIL_PENDING_UNITS]) + needed.units;
  return documents <= state->pending_document_capacity && tokens <= state->pending_token_capacity &&
         units <= state->pending_unit_capacity;
}

static uint32_t copy_units(narsil_frozen_segment_state *state, uint32_t start, const uint16_t *units, uint32_t length) {
  for (uint32_t unit = 0; unit < length; unit++) { state->pending_units[start + unit] = units[unit]; }
  return start + length;
}

void frozen_pending_append(const narsil_remove_frozen_request *request) {
  narsil_frozen_segment_state *state = request->state;
  uint32_t *header = state->pending_header;
  state->pending_documents[header[NARSIL_PENDING_DOCUMENTS]] = request->ordinal;
  uint32_t written = header[NARSIL_PENDING_TOKENS];
  uint32_t units = header[NARSIL_PENDING_UNITS];
  for (size_t at = 0; at < request->field_count; at++) {
    const narsil_field_tokens *field = request->fields + at;
    for (size_t index = 0; index < field->tokens.token_count; index++) {
      const narsil_token *token = field->tokens.tokens + index;
      uint32_t *words = state->pending_tokens + ((size_t)written++ * NARSIL_PENDING_TOKEN_WORDS);
      words[0] = field->field;
      words[1] = units;
      words[2] = token->term_length;
      units = copy_units(state, units, field->tokens.units + token->term_offset, token->term_length);
      if (token->surface_offset == NARSIL_NO_SURFACE) {
        words[3] = NARSIL_NO_SURFACE;
        words[4] = 0;
        continue;
      }
      words[3] = units;
      words[4] = token->surface_length;
      units = copy_units(state, units, field->tokens.units + token->surface_offset, token->surface_length);
    }
  }
}

static int tombstoned(const narsil_frozen_segment_state *state, uint32_t ordinal) {
  return (state->tombstones[ordinal / FROZEN_WORD_BITS] & (UINT32_C(1) << (ordinal % FROZEN_WORD_BITS))) != 0;
}

static narsil_status make_room(narsil_workspace *workspace, const narsil_remove_frozen_request *request,
                               frozen_pending_size *needed) {
  if (workspace == NULL) { return NARSIL_INVALID_ARGUMENT; }
  *needed = frozen_pending_needed(request);
  if (!pending_fits(request->state, *needed, 1)) { return NARSIL_NEEDS_ROOM; }
  if (pending_fits(request->state, *needed, 0)) { return NARSIL_OK; }
  return frozen_settle(workspace, request->segment, request->state, request->paged);
}

narsil_status narsil_remove_frozen_document(narsil_workspace *workspace, const narsil_remove_frozen_request *request) {
  narsil_status status = frozen_removal_regions(request);
  if (status != NARSIL_OK) { return status; }
  narsil_frozen_segment_state *state = request->state;
  if (tombstoned(state, request->ordinal)) { return NARSIL_OK; }
  if (*state->tombstone_count == request->segment->document_count) { return NARSIL_INVALID_ARGUMENT; }
  frozen_pending_size needed = {0};
  status = make_room(workspace, request, &needed);
  if (status != NARSIL_OK) { return status; }
  frozen_pending_append(request);
  state->pending_header[NARSIL_PENDING_DOCUMENTS] += (uint32_t)needed.documents;
  state->pending_header[NARSIL_PENDING_TOKENS] += (uint32_t)needed.tokens;
  state->pending_header[NARSIL_PENDING_UNITS] += (uint32_t)needed.units;
  state->tombstones[request->ordinal / FROZEN_WORD_BITS] |= UINT32_C(1) << (request->ordinal % FROZEN_WORD_BITS);
  (*state->tombstone_count)++;
  return NARSIL_OK;
}

enum { TOMBSTONES = 4, TOMBSTONE_COUNT = 5, PENDING_HEADER = 6, PREPARED_REPLACEMENTS = 5 };

typedef struct {
  uint32_t kind;
  uint32_t entry;
  double value;
} frozen_replacement;

static void update(const narsil_frozen_removal_output *output, size_t position, frozen_replacement replacement) {
  output->entries[position * 2] = replacement.kind;
  output->entries[(position * 2) + 1] = replacement.entry;
  output->values[position] = replacement.value;
}

narsil_status narsil_prepare_frozen_removal(narsil_workspace *workspace, const narsil_remove_frozen_request *request,
                                            const narsil_frozen_removal_output *output, size_t *count) {
  narsil_status status = frozen_removal_regions(request);
  if (status != NARSIL_OK) { return status; }
  status = frozen_removal_output_regions(request, output, count);
  if (status != NARSIL_OK) { return status; }
  const narsil_frozen_segment_state *state = request->state;
  if (tombstoned(state, request->ordinal)) {
    *count = 0;
    return NARSIL_OK;
  }
  if (*state->tombstone_count == request->segment->document_count) { return NARSIL_INVALID_ARGUMENT; }
  if (output->entry_capacity < PREPARED_REPLACEMENTS || output->value_capacity < PREPARED_REPLACEMENTS) {
    return NARSIL_NEEDS_ROOM;
  }
  frozen_pending_size needed = {0};
  status = make_room(workspace, request, &needed);
  if (status != NARSIL_OK) { return status; }
  frozen_pending_append(request);
  const uint32_t *header = state->pending_header;
  uint32_t word = request->ordinal / FROZEN_WORD_BITS;
  uint32_t bits = state->tombstones[word] | (UINT32_C(1) << (request->ordinal % FROZEN_WORD_BITS));
  uint32_t documents = header[NARSIL_PENDING_DOCUMENTS] + (uint32_t)needed.documents;
  uint32_t tokens = header[NARSIL_PENDING_TOKENS] + (uint32_t)needed.tokens;
  uint32_t units = header[NARSIL_PENDING_UNITS] + (uint32_t)needed.units;
  update(output, 0, (frozen_replacement){TOMBSTONES, word, bits});
  update(output, 1, (frozen_replacement){TOMBSTONE_COUNT, 0, (double)*state->tombstone_count + 1});
  update(output, 2, (frozen_replacement){PENDING_HEADER, NARSIL_PENDING_DOCUMENTS, documents});
  update(output, 3, (frozen_replacement){PENDING_HEADER, NARSIL_PENDING_TOKENS, tokens});
  update(output, 4, (frozen_replacement){PENDING_HEADER, NARSIL_PENDING_UNITS, units});
  *count = PREPARED_REPLACEMENTS;
  return NARSIL_OK;
}

narsil_status narsil_settle_frozen_state(narsil_workspace *workspace, const narsil_frozen_segment *segment,
                                         narsil_frozen_segment_state *state,
                                         const narsil_frozen_paged_removals *paged) {
  narsil_status status = frozen_settle_regions(segment, state);
  if (status != NARSIL_OK) { return status; }
  if (workspace == NULL ||
      (paged != NULL && ((uintptr_t)paged % _Alignof(narsil_frozen_paged_removals) != 0 || paged->offsets == NULL ||
                         paged->values == NULL || paged->fault == NULL))) {
    return NARSIL_INVALID_ARGUMENT;
  }
  return frozen_settle(workspace, segment, state, paged);
}
