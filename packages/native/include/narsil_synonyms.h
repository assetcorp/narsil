#ifndef NARSIL_SYNONYMS_H
#define NARSIL_SYNONYMS_H

#include "narsil_core.h"

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef struct {
  const uint8_t *tokens;
  size_t token_bytes;
  const uint32_t *offsets;
  size_t token_count;
  const uint32_t *rule_start;
  const int32_t *rule_source;
  size_t rule_count;
  const uint32_t *rule_tokens;
  size_t rule_token_count;
  const uint32_t *token_start;
  const uint32_t *token_rules;
  size_t token_rule_count;
} narsil_synonym_table;

typedef struct {
  const narsil_synonym_table *table;
  const uint16_t *units;
  size_t unit_count;
  const uint32_t *starts;
  size_t query_count;
} narsil_synonym_request;

typedef struct {
  uint32_t *queries;
  size_t query_capacity;
  uint32_t *starts;
  size_t start_capacity;
  uint32_t *tokens;
  size_t token_capacity;
} narsil_synonym_output;

narsil_status narsil_expand_synonyms(const narsil_synonym_request *request, const narsil_synonym_output *output,
                                     uint32_t *count);

#ifdef __cplusplus
}
#endif

#endif
