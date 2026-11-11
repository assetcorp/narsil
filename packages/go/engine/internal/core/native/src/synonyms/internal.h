#ifndef NARSIL_SYNONYMS_INTERNAL_H
#define NARSIL_SYNONYMS_INTERNAL_H

#include "../../include/narsil_synonyms.h"

#include <stdint.h>

enum { SYNONYM_BUDGET = 50 };

int synonym_regions(const narsil_synonym_request *request, const narsil_synonym_output *output, uint32_t *count);
int synonym_offsets(const uint32_t *offsets, size_t count, size_t end);
int64_t synonym_rank(const narsil_synonym_request *request, uint32_t query);

#endif
