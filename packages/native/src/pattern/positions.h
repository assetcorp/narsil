#ifndef NARSIL_PATTERN_POSITIONS_H
#define NARSIL_PATTERN_POSITIONS_H

#include "../../include/narsil_core.h"
#include "../analysis/text.h"
#include "ast.h"

#include <stdint.h>

enum { PATTERN_FOLD_WORDS = 4 };

narsil_status pattern_multi_folds(const pattern_ast *tree, uint32_t set, narsil_code_points *folds);
narsil_status pattern_tree_order(const pattern_ast *tree, uint32_t root, narsil_code_points *order);
narsil_status pattern_position_counts(const pattern_ast *tree, const narsil_code_points *order, uint32_t case_fold,
                                      narsil_code_points *counts, narsil_code_points *folds);

#endif
