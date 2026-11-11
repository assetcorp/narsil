#ifndef NARSIL_ANALYSIS_SPLIT_H
#define NARSIL_ANALYSIS_SPLIT_H

#include "languages.h"

#include <stddef.h>
#include <stdint.h>

typedef struct {
  uint32_t start;
  uint32_t length;
} narsil_span;

typedef struct {
  narsil_span *spans;
  size_t length;
  size_t capacity;
} narsil_spans;

int narsil_spans_push(narsil_spans *spans, narsil_span span);
void narsil_spans_release(narsil_spans *spans);

int narsil_split(const narsil_language *language, const uint16_t *units, uint32_t length, narsil_spans *parts);
int narsil_expand_ngrams(const uint16_t *units, narsil_span part, uint32_t size, narsil_spans *out,
                         narsil_code_points *offsets);

#endif
