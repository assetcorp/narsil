#ifndef NARSIL_ANALYSIS_TERM_CACHE_H
#define NARSIL_ANALYSIS_TERM_CACHE_H

#include <stddef.h>
#include <stdint.h>

#define NARSIL_TERM_CACHE_UNITS 24U

typedef struct {
  uint32_t tag;
  uint16_t key_length;
  uint16_t value_length;
  uint16_t key[NARSIL_TERM_CACHE_UNITS];
  uint16_t value[NARSIL_TERM_CACHE_UNITS];
} narsil_term_slot;

typedef struct {
  narsil_term_slot *slots;
  uint8_t *next_victim;
  int unavailable;
} narsil_term_cache;

typedef struct {
  uint32_t language_index;
  uint32_t flags;
  const uint16_t *units;
  size_t length;
} narsil_term_key;

narsil_term_slot *narsil_term_cache_find(narsil_term_cache *cache, const narsil_term_key *key,
                                         narsil_term_slot **victim);
int narsil_term_cache_store(narsil_term_slot *slot, const narsil_term_key *key, const uint16_t *value, size_t length);
uint32_t narsil_term_cache_index(const narsil_term_cache *cache, const narsil_term_slot *slot);
void narsil_term_cache_release(narsil_term_cache *cache);

#endif
