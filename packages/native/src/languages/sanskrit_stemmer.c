#include "../../include/narsil_core.h"
#include "../analysis/normalise.h"
#include "../analysis/text.h"
#include "rules.h"

#include <stddef.h>
#include <stdint.h>

#define MIN_STEMMED_CODE_POINTS 4U
#define MIN_REMAINING_CODE_POINTS 3U
#define COUNT_OF(array) (sizeof(array) / sizeof((array)[0]))

static const uint16_t *const long_nominal_endings[] = {
    u"आभ्याम्", u"ाभ्याम्", u"आनाम्", u"एभ्यः", u"ाणाम्", u"ेभ्यः",
};

static const uint16_t *const medium_nominal_endings[] = {
    u"स्य", u"ेषु", u"ात्", u"ाम्", u"ान्", u"ेन", u"या", u"ाः", u"अः", u"म्", u"ाम", u"ौ", u"ः", u"आ",
};

static const uint16_t *const verb_endings[] = {
    u"न्ति", u"न्ते", u"न्तु", u"अम्", u"सि", u"ति", u"मि", u"ते", u"से", u"तु",
};

static const uint16_t *const short_nominal_endings[] = {
    u"ा", u"ि", u"ी", u"ु", u"ू", u"े", u"ो", u"ं",
};

static int remove_ending(narsil_text *word, const uint16_t *const *endings, size_t ending_count) {
  for (size_t i = 0; i < ending_count; i++) {
    if (!narsil_rule_ends_with(word, endings[i])) { continue; }
    size_t remaining = word->length - narsil_rule_length(endings[i]);
    if (narsil_rule_code_point_count(word->units, remaining) >= MIN_REMAINING_CODE_POINTS) {
      word->length = remaining;
      return 1;
    }
  }
  return 0;
}

int narsil_sanskrit_stem(const uint16_t *units, size_t length, narsil_text *out, narsil_normalise_scratch *scratch) {
  (void)scratch;
  int status = narsil_text_assign(out, units, length);
  if (status != NARSIL_OK || narsil_rule_code_point_count(units, length) < MIN_STEMMED_CODE_POINTS) { return status; }
  if (remove_ending(out, long_nominal_endings, COUNT_OF(long_nominal_endings))) { return NARSIL_OK; }
  if (remove_ending(out, medium_nominal_endings, COUNT_OF(medium_nominal_endings))) { return NARSIL_OK; }
  if (remove_ending(out, verb_endings, COUNT_OF(verb_endings))) { return NARSIL_OK; }
  remove_ending(out, short_nominal_endings, COUNT_OF(short_nominal_endings));
  return NARSIL_OK;
}
