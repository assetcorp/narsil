#ifndef NARSIL_PHRASE_INTERNAL_H
#define NARSIL_PHRASE_INTERNAL_H

#include "../../include/narsil_phrases.h"
#include "../work/tally.h"
#include "scratch.h"

#include <stddef.h>
#include <stdint.h>

enum { PHRASE_ROW_WORDS = 3, PHRASE_WORD_BITS = 32 };

size_t phrase_bitmap_words(uint32_t count);
int phrase_regions(const narsil_phrase_request *request, const narsil_phrase_output *output, uint32_t *count);
int phrase_shape(const narsil_phrase_request *request);
int phrase_row_valid(const narsil_phrase_request *request, const narsil_phrase_postings *list, uint32_t row);
narsil_status phrase_prepare(phrase_scratch *scratch, const narsil_phrase_request *request, work_tally *tally,
                             int *missing);
narsil_status phrase_collect(phrase_scratch *scratch, const narsil_phrase_request *request,
                             const narsil_phrase_output *output, work_tally *tally);

#endif
