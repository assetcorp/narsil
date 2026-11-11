#ifndef NARSIL_FUZZ_TERMS_H
#define NARSIL_FUZZ_TERMS_H

#include "input.h"

#include "../include/narsil_core.h"
#include "../include/narsil_expansion.h"
#include "../include/narsil_segment_merge.h"
#include "../include/narsil_terms.h"

#include <stdint.h>

void fuzz_lookup(narsil_workspace *workspace, fuzz_input *input, const narsil_term_dictionary *dictionary);
void fuzz_exact_batch(narsil_workspace *workspace, fuzz_input *input, const narsil_term_dictionary *dictionary);
void fuzz_frequency(fuzz_input *input, const narsil_term_dictionary *dictionary, uint32_t token_count);
void fuzz_prefix(narsil_workspace *workspace, fuzz_input *input, const narsil_expansion_segment *source);
void fuzz_partial(narsil_workspace *workspace, fuzz_input *input, const narsil_expansion_segment *source,
                  const narsil_frozen_runs *runs);
void fuzz_suggest(narsil_workspace *workspace, fuzz_input *input, const narsil_expansion_segment *source);
void fuzz_merge_into(narsil_workspace *workspace, fuzz_input *input, const narsil_keyword_merge_request *request);

#endif
