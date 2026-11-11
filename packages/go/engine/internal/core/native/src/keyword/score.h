#ifndef NARSIL_KEYWORD_SCORE_H
#define NARSIL_KEYWORD_SCORE_H

#include "pass.h"
#include "rows.h"

#include <stdint.h>

#define KEYWORD_NOT_PRUNED UINT32_MAX

void keyword_list_keys(const keyword_pass *pass, uint32_t list, keyword_row_keys *keys);
const uint32_t *keyword_rank_ordered_run(const keyword_pass *pass, const keyword_row_keys *keys, uint32_t begin,
                                         uint32_t count);
uint32_t keyword_score_every_slot(const keyword_pass *pass);
uint32_t keyword_score_pruned(const keyword_pass *pass);

#endif
