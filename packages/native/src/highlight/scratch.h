#ifndef NARSIL_HIGHLIGHT_SCRATCH_H
#define NARSIL_HIGHLIGHT_SCRATCH_H

#include "../../include/narsil_highlight.h"
#include "../analysis/normalise.h"
#include "../analysis/split.h"
#include "../analysis/text.h"
#include "../terms/scratch.h"

#include <stddef.h>
#include <stdint.h>

typedef struct {
  uint32_t point;
  uint32_t start;
  uint32_t end;
  size_t order;
  size_t next;
} highlight_origin;

typedef struct {
  highlight_origin *origins;
  size_t origin_count;
  size_t origin_capacity;
  narsil_text width;
  narsil_text composed;
  narsil_code_points decomposed;
  narsil_spans offsets;
  narsil_spans marked;
  narsil_text snippet;
  term_scratch distance;
} highlight_scratch;

highlight_scratch *workspace_highlight_scratch(narsil_workspace *workspace);
void highlight_release(highlight_scratch *scratch);
size_t highlight_bytes(const highlight_scratch *scratch);
narsil_status highlight_offsets(highlight_scratch *scratch, const uint16_t *text, size_t length);
narsil_status highlight_matches(narsil_analyser *analyser, highlight_scratch *scratch,
                                const narsil_highlight_request *request);
narsil_status highlight_render(highlight_scratch *scratch, const narsil_highlight_request *request,
                               const narsil_highlight_output *output, uint32_t *count);

#endif
