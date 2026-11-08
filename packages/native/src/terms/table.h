#ifndef NARSIL_TERM_TABLE_INTERNAL_H
#define NARSIL_TERM_TABLE_INTERNAL_H

#include "../../include/narsil_terms.h"
#include "../regions.h"

#include <stddef.h>
#include <stdint.h>

enum { TERM_COUNT, TERM_LIVE_COUNT, TERM_SLOT_CAPACITY, TERM_GENERATION, TERM_UNITS_USED };
enum { TERM_HEADER_WORDS = 8, TERM_HEAD_COUNT = 65536, TERM_TABLE_REGIONS = 8 };

int term_table_regions(const narsil_term_table *table, memory_region regions[TERM_TABLE_REGIONS]);
uint32_t term_hash(const uint16_t *units, size_t length);
int64_t term_table_find(const narsil_term_table *table, const uint16_t *units, size_t length);

#endif
