#ifndef NARSIL_EXPANSION_H
#define NARSIL_EXPANSION_H

#include "narsil_core.h"
#include "narsil_frozen_segments.h"
#include "narsil_segments.h"

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef struct {
  const narsil_growing_segment *growing;
  const narsil_frozen_segment *frozen;
  const narsil_frozen_segment_state *state;
  const double *occurrences;
  size_t occurrence_count;
} narsil_expansion_segment;

typedef struct {
  const narsil_expansion_segment *segments;
  size_t segment_count;
  const uint16_t *typed;
  size_t typed_length;
  const uint16_t *stemmed;
  size_t stemmed_length;
  const uint16_t *own;
  size_t own_length;
} narsil_prefix_request;

typedef struct {
  uint32_t *segments;
  size_t segment_capacity;
  uint32_t *tokens;
  size_t token_capacity;
  double *factors;
  size_t factor_capacity;
} narsil_expansion_output;

typedef struct {
  const uint32_t *points;
  size_t point_count;
  const uint32_t *offsets;
  size_t offset_count;
  const uint32_t *members;
  size_t member_count;
} narsil_frozen_runs;

typedef struct {
  const uint16_t *written;
  size_t written_length;
  const uint16_t *own;
  size_t own_length;
  uint32_t tolerance;
  uint32_t prefix_length;
} narsil_partial_word;

typedef struct {
  const narsil_expansion_segment *segments;
  const narsil_frozen_runs *runs;
  size_t segment_count;
  const narsil_partial_word *words;
  size_t word_count;
} narsil_partial_request;

typedef struct {
  narsil_expansion_output additions;
  uint32_t *starts;
  size_t start_capacity;
} narsil_partial_output;

narsil_status narsil_expand_prefix(narsil_workspace *workspace, const narsil_prefix_request *request,
                                   const narsil_expansion_output *output, uint32_t *count);
narsil_status narsil_expand_partial_words(narsil_workspace *workspace, const narsil_partial_request *request,
                                          const narsil_partial_output *output, uint32_t *count);

#ifdef __cplusplus
}
#endif

#endif
