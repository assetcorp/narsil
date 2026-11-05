#include "../../include/narsil_core.h"
#include "../analysis/normalise.h"
#include "../analysis/text.h"
#include "rules.h"

#include <stddef.h>
#include <stdint.h>

#define MIN_STEMMED_UNITS 4U
#define LONGER_THAN_THREE 3U
#define LONGER_THAN_FOUR 4U
#define LONGER_THAN_FIVE 5U
#define LONGER_THAN_SIX 6U
#define NO_REPLACEMENT 0U
#define CYRILLIC_G 0x0433U
#define CYRILLIC_IE 0x0435U
#define CYRILLIC_I 0x0438U
#define CYRILLIC_SHORT_I 0x0439U
#define CYRILLIC_KA 0x043AU
#define CYRILLIC_EN 0x043DU
#define CYRILLIC_HA 0x0445U
#define CYRILLIC_HARD_SIGN 0x044AU
#define CYRILLIC_YA 0x044FU
#define COUNT_OF(array) (sizeof(array) / sizeof((array)[0]))

typedef struct {
  size_t longer_than;
  const uint16_t *suffix;
  size_t dropped;
  uint16_t replacement;
} suffix_rule;

static const suffix_rule leading_plural_rules[] = {
    {LONGER_THAN_FIVE, u"ища", 3, NO_REPLACEMENT},
};

static const suffix_rule definite_article_rules[] = {
    {LONGER_THAN_SIX, u"ият", 3, NO_REPLACEMENT}, {LONGER_THAN_FIVE, u"ът", 2, NO_REPLACEMENT},
    {LONGER_THAN_FIVE, u"то", 2, NO_REPLACEMENT}, {LONGER_THAN_FIVE, u"те", 2, NO_REPLACEMENT},
    {LONGER_THAN_FIVE, u"та", 2, NO_REPLACEMENT}, {LONGER_THAN_FIVE, u"ия", 2, NO_REPLACEMENT},
    {LONGER_THAN_FOUR, u"ят", 2, NO_REPLACEMENT},
};

static const suffix_rule plural_rules[] = {
    {LONGER_THAN_SIX, u"овци", 3, NO_REPLACEMENT},  {LONGER_THAN_SIX, u"ове", 3, NO_REPLACEMENT},
    {LONGER_THAN_SIX, u"еве", 3, CYRILLIC_SHORT_I}, {LONGER_THAN_FIVE, u"ища", 3, NO_REPLACEMENT},
    {LONGER_THAN_FIVE, u"та", 2, NO_REPLACEMENT},   {LONGER_THAN_FIVE, u"ци", 2, CYRILLIC_KA},
    {LONGER_THAN_FIVE, u"зи", 2, CYRILLIC_G},
};

static const suffix_rule late_plural_rules[] = {
    {LONGER_THAN_FOUR, u"си", 2, CYRILLIC_HA},
    {LONGER_THAN_FOUR, u"и", 1, NO_REPLACEMENT},
};

static const suffix_rule vowel_rules[] = {
    {LONGER_THAN_THREE, u"я", 1, NO_REPLACEMENT},
    {LONGER_THAN_THREE, u"а", 1, NO_REPLACEMENT},
    {LONGER_THAN_THREE, u"о", 1, NO_REPLACEMENT},
    {LONGER_THAN_THREE, u"е", 1, NO_REPLACEMENT},
};

static const suffix_rule en_rules[] = {
    {LONGER_THAN_FOUR, u"ен", 2, CYRILLIC_EN},
};

static int apply_first(narsil_text *word, const suffix_rule *rules, size_t rule_count, int *applied) {
  *applied = 0;
  for (size_t i = 0; i < rule_count; i++) {
    if (word->length <= rules[i].longer_than || !narsil_rule_ends_with(word, rules[i].suffix)) { continue; }
    *applied = 1;
    word->length -= rules[i].dropped;
    return rules[i].replacement == NO_REPLACEMENT ? NARSIL_OK : narsil_text_push(word, rules[i].replacement);
  }
  return NARSIL_OK;
}

static int is_plural_in_e_and_i(const narsil_text *word) {
  return word->length > LONGER_THAN_FIVE && word->units[word->length - 1] == CYRILLIC_I &&
         word->units[word->length - 3] == CYRILLIC_IE;
}

static int plural(narsil_text *word) {
  int applied = 0;
  int status = apply_first(word, plural_rules, COUNT_OF(plural_rules), &applied);
  if (status != NARSIL_OK || applied) { return status; }
  if (is_plural_in_e_and_i(word)) {
    uint16_t kept = word->units[word->length - 2];
    word->length -= 3;
    status = narsil_text_push(word, CYRILLIC_YA);
    return status == NARSIL_OK ? narsil_text_push(word, kept) : status;
  }
  return apply_first(word, late_plural_rules, COUNT_OF(late_plural_rules), &applied);
}

int narsil_bulgarian_stem(const uint16_t *units, size_t length, narsil_text *out, narsil_normalise_scratch *scratch) {
  (void)scratch;
  int applied = 0;
  int status = narsil_text_assign(out, units, length);
  if (status != NARSIL_OK || length < MIN_STEMMED_UNITS) { return status; }
  status = apply_first(out, leading_plural_rules, COUNT_OF(leading_plural_rules), &applied);
  if (status == NARSIL_OK) {
    status = apply_first(out, definite_article_rules, COUNT_OF(definite_article_rules), &applied);
  }
  if (status == NARSIL_OK) { status = plural(out); }
  if (status == NARSIL_OK) { status = apply_first(out, vowel_rules, COUNT_OF(vowel_rules), &applied); }
  if (status == NARSIL_OK) { status = apply_first(out, en_rules, COUNT_OF(en_rules), &applied); }
  if (status == NARSIL_OK && out->length > LONGER_THAN_FIVE && out->units[out->length - 2] == CYRILLIC_HARD_SIGN) {
    uint16_t last = out->units[out->length - 1];
    out->length -= 2;
    status = narsil_text_push(out, last);
  }
  return status;
}
