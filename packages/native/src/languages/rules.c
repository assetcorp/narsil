#include "rules.h"

#include "../../include/narsil_core.h"
#include "../analysis/text.h"

#include <stddef.h>
#include <stdint.h>
#include <string.h>

static const narsil_unit_substitution *substitution_for(uint16_t unit, const narsil_unit_substitution *substitutions,
                                                        size_t substitution_count) {
  for (size_t i = 0; i < substitution_count; i++) {
    if (unit >= substitutions[i].first && unit <= substitutions[i].last) { return &substitutions[i]; }
  }
  return NULL;
}

int narsil_substitute_units(const uint16_t *units, size_t length, const narsil_unit_substitution *substitutions,
                            size_t substitution_count, narsil_text *out) {
  out->length = 0;
  int status = narsil_text_reserve(out, length + 1);
  for (size_t i = 0; i < length && status == NARSIL_OK; i++) {
    const narsil_unit_substitution *substitution = substitution_for(units[i], substitutions, substitution_count);
    if (substitution == NULL) {
      status = narsil_text_push(out, units[i]);
    } else {
      status = narsil_text_append(out, substitution->replacement, substitution->length);
    }
  }
  return status;
}

size_t narsil_rule_length(const uint16_t *literal) {
  size_t length = 0;
  while (literal[length] != 0) { length++; }
  return length;
}

int narsil_rule_ends_with(const narsil_text *word, const uint16_t *suffix) {
  size_t length = narsil_rule_length(suffix);
  if (length > word->length) { return 0; }
  return memcmp(word->units + (word->length - length), suffix, length * sizeof(uint16_t)) == 0;
}

int narsil_rule_starts_with(const narsil_text *word, const uint16_t *prefix) {
  size_t length = narsil_rule_length(prefix);
  if (length > word->length) { return 0; }
  return memcmp(word->units, prefix, length * sizeof(uint16_t)) == 0;
}

int narsil_rule_ends_with_unit(const narsil_text *word, uint16_t unit) {
  return word->length > 0 && word->units[word->length - 1] == unit;
}

size_t narsil_rule_code_point_count(const uint16_t *units, size_t length) {
  size_t count = 0;
  size_t index = 0;
  while (index < length) {
    narsil_decode_next(units, length, &index);
    count++;
  }
  return count;
}
