#ifndef NARSIL_FOLDING_H
#define NARSIL_FOLDING_H

#include "narsil_analysis.h"
#include "narsil_core.h"
#include "narsil_expansion.h"

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

#define NARSIL_FOLD_STEM (1U << 0)

typedef struct narsil_fold_table narsil_fold_table;

typedef struct {
  const uint16_t *key;
  size_t key_length;
  const uint16_t *own;
  size_t own_length;
  const narsil_term *excluded;
  size_t excluded_count;
  uint32_t tolerance;
  uint32_t prefix_length;
} narsil_folded_word;

typedef struct {
  const narsil_expansion_segment *segments;
  const narsil_fold_table *const *tables;
  size_t segment_count;
  const narsil_folded_word *words;
  size_t word_count;
} narsil_folded_request;

typedef struct {
  uint32_t *segments;
  size_t segment_capacity;
  uint32_t *tokens;
  size_t token_capacity;
  uint32_t *starts;
  size_t start_capacity;
} narsil_folded_output;

typedef struct {
  narsil_prefix_request prefix;
  const narsil_fold_table *const *tables;
  const uint16_t *folded;
  size_t folded_length;
} narsil_folded_prefix_request;

typedef struct {
  narsil_partial_request partial;
  const narsil_fold_table *const *tables;
  const narsil_term *folded;
} narsil_folded_partial_request;

narsil_status narsil_language_folds(uint32_t language, uint32_t *folds);
narsil_status narsil_fold_spelling(narsil_analyser *analyser, uint32_t language, const uint16_t *units, uint32_t length,
                                   uint32_t flags, narsil_term *term);

narsil_status narsil_fold_table_create(narsil_fold_table **table);
void narsil_fold_table_destroy(narsil_fold_table *table);
size_t narsil_fold_table_bytes(const narsil_fold_table *table);
int narsil_fold_table_current(const narsil_fold_table *table, const narsil_expansion_segment *segment,
                              uint32_t language);
narsil_status narsil_fold_table_update(narsil_workspace *workspace, narsil_analyser *analyser, narsil_fold_table *table,
                                       const narsil_expansion_segment *segment, uint32_t language);

narsil_status narsil_expand_folded_terms(narsil_workspace *workspace, const narsil_folded_request *request,
                                         const narsil_folded_output *output, uint32_t *count);
narsil_status narsil_expand_folded_prefix(narsil_workspace *workspace, const narsil_folded_prefix_request *request,
                                          const narsil_expansion_output *output, uint32_t *count);
narsil_status narsil_expand_folded_partial_words(narsil_workspace *workspace,
                                                 const narsil_folded_partial_request *request,
                                                 const narsil_partial_output *output, uint32_t *count);

#ifdef __cplusplus
}
#endif

#endif
