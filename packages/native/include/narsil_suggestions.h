#ifndef NARSIL_SUGGESTIONS_H
#define NARSIL_SUGGESTIONS_H

#include "narsil_core.h"
#include "narsil_expansion.h"

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

enum { NARSIL_SUGGESTION_TOKEN = 0, NARSIL_SUGGESTION_SURFACE = 1, NARSIL_SUGGESTION_WORDS = 3 };

typedef struct {
  const narsil_expansion_segment *segments;
  size_t segment_count;
  const uint16_t *typed;
  size_t typed_length;
  const uint16_t *stemmed;
  size_t stemmed_length;
  uint32_t limit;
} narsil_suggestion_request;

typedef struct {
  uint32_t *terms;
  size_t term_words;
  uint32_t *starts;
  size_t start_capacity;
  uint32_t *spellings;
  size_t spelling_words;
  double *occurrences;
  size_t occurrence_capacity;
} narsil_suggestion_output;

narsil_status narsil_suggest_terms(narsil_workspace *workspace, const narsil_suggestion_request *request,
                                   const narsil_suggestion_output *output, uint32_t *count);

#ifdef __cplusplus
}
#endif

#endif
