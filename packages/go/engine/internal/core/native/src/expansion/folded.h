#ifndef NARSIL_EXPANSION_FOLDED_H
#define NARSIL_EXPANSION_FOLDED_H

#include "../../include/narsil_expansion.h"
#include "../../include/narsil_folding.h"
#include "../segments/regions.h"

#include <stddef.h>
#include <stdint.h>

int folded_tables_valid(const segment_regions *regions, const narsil_expansion_segment *segments,
                        const narsil_fold_table *const *tables, size_t count);
int folded_regions(const narsil_folded_request *request, const narsil_folded_output *output, uint32_t *count);
int folded_prefix_regions(const narsil_folded_prefix_request *request, const narsil_expansion_output *output,
                          uint32_t *count);
int folded_partial_regions(const narsil_folded_partial_request *request, const narsil_partial_output *output,
                           uint32_t *count);

#endif
