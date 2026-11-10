#ifndef NARSIL_HIGHLIGHT_H
#define NARSIL_HIGHLIGHT_H

#include "narsil_analysis.h"
#include "narsil_core.h"

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef struct {
  const uint16_t *units;
  size_t length;
} narsil_highlight_text;

typedef struct {
  narsil_highlight_text text;
  uint32_t tolerance;
} narsil_highlight_term;

typedef struct {
  const narsil_highlight_term *terms;
  size_t term_count;
  uint32_t prefix_length;
  narsil_highlight_text prefix;
  const narsil_highlight_text *synonyms;
  size_t synonym_count;
  const narsil_highlight_text *partial_words;
  size_t partial_count;
} narsil_highlight_query;

typedef struct {
  uint32_t language;
  narsil_highlight_text text;
  narsil_highlight_query query;
  narsil_highlight_text pre_tag;
  narsil_highlight_text post_tag;
  uint32_t maximum;
} narsil_highlight_request;

typedef struct {
  uint16_t *snippet;
  size_t snippet_capacity;
  uint32_t *positions;
  size_t position_words;
  uint32_t *snippet_length;
  size_t length_capacity;
} narsil_highlight_output;

narsil_status narsil_highlight(narsil_analyser *analyser, narsil_workspace *workspace,
                               const narsil_highlight_request *request, const narsil_highlight_output *output,
                               uint32_t *count);

#ifdef __cplusplus
}
#endif

#endif
