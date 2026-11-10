#ifndef NARSIL_SORT_TEXT_H
#define NARSIL_SORT_TEXT_H

#include <stddef.h>
#include <stdint.h>

extern const uint32_t narsil_case_folds[][5];
extern const size_t narsil_case_fold_count;

size_t sort_text_length(const uint16_t *units, size_t length);
int sort_text_compare(const uint16_t *left, size_t left_length, const uint16_t *right, size_t right_length);

#endif
