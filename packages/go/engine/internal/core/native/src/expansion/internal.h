#ifndef NARSIL_EXPANSION_INTERNAL_H
#define NARSIL_EXPANSION_INTERNAL_H

#include "../../include/narsil_expansion.h"
#include "../../include/narsil_terms.h"
#include "../analysis/text.h"
#include "../segments/regions.h"
#include "../terms/dictionary.h"
#include "../terms/scratch.h"
#include "suggestions.h"

#include <stddef.h>
#include <stdint.h>

enum { PREFIX_BUDGET = 50, PARTIAL_BUDGET = 50, PARTIAL_RUN_POINTS = 3 };

typedef struct {
  term_cursor text;
  uint32_t segment;
  uint32_t token;
  double documents;
  size_t spelling_length;
} expansion_candidate;

typedef struct {
  expansion_candidate *candidates;
  size_t count;
  size_t capacity;
  narsil_code_points matches;
  narsil_text text;
  double *surface_occurrences;
  size_t surface_capacity;
  term_scratch typo;
  narsil_code_points written;
  narsil_code_points failure;
  narsil_code_points starts;
  suggestion_scratch suggestions;
} expansion_scratch;

expansion_scratch *workspace_expansion_scratch(narsil_workspace *workspace);
void expansion_scratch_release(expansion_scratch *scratch);
size_t expansion_scratch_bytes(const expansion_scratch *scratch);
narsil_status expansion_add(expansion_scratch *scratch, const narsil_expansion_segment *source, uint32_t segment,
                            uint32_t token, size_t spelling_length);
int expansion_dictionary(const narsil_expansion_segment *source, narsil_term_dictionary *dictionary);
int expansion_compare(term_cursor first, term_cursor second);
int expansion_cursor_text(term_cursor cursor, narsil_text *text);
int expansion_regions(const narsil_prefix_request *request, const narsil_expansion_output *output, uint32_t *count);
int expansion_source_regions(const narsil_expansion_segment *source, const segment_regions *outputs);
int expansion_text_region(const segment_regions *outputs, const uint16_t *text, size_t length);
int partial_regions(const narsil_partial_request *request, const narsil_partial_output *output, uint32_t *count);
int partial_members(const narsil_expansion_segment *source, const narsil_frozen_runs *runs,
                    const narsil_code_points *query, const uint32_t **members, size_t *count);
int partial_spelling(const narsil_expansion_segment *source, uint32_t entry, term_cursor *text, uint32_t *token,
                     size_t *length);
narsil_status partial_collect(narsil_workspace *workspace, expansion_scratch *scratch,
                              const narsil_partial_request *request, const narsil_partial_word *word);
double expansion_occurrences(const narsil_expansion_segment *source, uint32_t token, double surface_occurrences);
int expansion_surface(const narsil_expansion_segment *source, uint32_t entry, term_cursor *spelling, term_cursor *token,
                      uint32_t *count);
uint32_t expansion_surface_count(const narsil_expansion_segment *source);
narsil_status expansion_find(narsil_workspace *workspace, expansion_scratch *scratch,
                             const narsil_expansion_segment *source, term_cursor text, uint32_t *token,
                             uint32_t *found);
narsil_status expansion_collect(narsil_workspace *workspace, expansion_scratch *scratch,
                                const narsil_prefix_request *request);
narsil_status expansion_rank(narsil_workspace *workspace, expansion_scratch *scratch,
                             const narsil_prefix_request *request);
int expansion_point_count(term_cursor cursor, size_t *count);
narsil_status suggestion_collect(narsil_workspace *workspace, expansion_scratch *scratch,
                                 const narsil_suggestion_request *request);

#endif
