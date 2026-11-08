#ifndef NARSIL_TERM_MATCHING_H
#define NARSIL_TERM_MATCHING_H

#include "../../include/narsil_terms.h"
#include "../analysis/text.h"
#include "dictionary.h"
#include "scratch.h"

#include <stddef.h>
#include <stdint.h>

#define TERM_TEXT_LIMIT ((size_t)1 << 30)

int term_points(term_cursor cursor, narsil_code_points *points);
int term_compare_query(term_cursor cursor, const narsil_code_points *query, size_t prefix, int *valid);
int term_matches(const narsil_term_lookup *request, term_scratch *scratch, uint32_t ordinal);
int term_within_distance(term_scratch *scratch, uint32_t tolerance);
void term_sort(const narsil_term_lookup *request, term_scratch *scratch);
void term_range(const narsil_term_lookup *request, const narsil_code_points *query, uint32_t *start, uint32_t *end);

#endif
