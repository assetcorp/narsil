#ifndef NARSIL_PACKED_TOKENS_H
#define NARSIL_PACKED_TOKENS_H

#include "narsil_analysis.h"

#ifdef __cplusplus
extern "C" {
#endif

narsil_status narsil_pack_tokens(const narsil_tokens *tokens, uint32_t *records, size_t capacity, uint16_t *units,
                                 size_t unit_capacity, uint32_t *unit_count);

#ifdef __cplusplus
}
#endif

#endif
