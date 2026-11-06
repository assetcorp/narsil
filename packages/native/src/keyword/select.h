#ifndef NARSIL_KEYWORD_SELECT_H
#define NARSIL_KEYWORD_SELECT_H

#include "pass.h"

#include <stdint.h>

uint32_t keyword_select_kept(const keyword_pass *pass);
uint32_t keyword_keep_best(const keyword_pass *pass, uint32_t candidates);
double keyword_touched_best_score(const keyword_pass *pass);
void keyword_clear_matched(const keyword_pass *pass);

static inline void keyword_mark_matched(uint32_t *matched, uint32_t ordinal) {
  matched[ordinal >> KEYWORD_WORD_SHIFT] |= 1U << (ordinal & KEYWORD_BIT_MASK);
}

#endif
