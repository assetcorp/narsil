#include "../../include/narsil_core.h"
#include "../analysis/normalise.h"
#include "../analysis/text.h"
#include "rules.h"

#include <stddef.h>
#include <stdint.h>

#define MIN_STEMMED_UNITS 4U
#define MIN_REMAINING_UNITS 3U

static const uint16_t *const noun_suffixes[] = {
    u"ovanje", u"evanje", u"acija", u"nosti", u"nost", u"osti", u"ost", u"ami", u"jem", u"oma",
    u"ima",    u"ov",     u"ev",    u"om",    u"em",   u"ih",   u"mi",  u"ah",  u"jo",  u"ju",
    u"ji",     u"ja",     u"je",    u"i",     u"e",    u"a",    u"o",   u"u",
};

static const uint16_t *const verb_suffixes[] = {
    u"ovati", u"evati", u"irati", u"ati", u"iti", u"eti", u"ali", u"ili", u"eli",
    u"ala",   u"ilo",   u"ila",   u"ale", u"ile", u"ele", u"al",  u"il",  u"el",
};

static const uint16_t *const adjective_suffixes[] = {
    u"skih", u"skim", u"sko", u"ske", u"ski", u"ska", u"nih", u"nim", u"no", u"ne", u"ni", u"na", u"en", u"ih", u"im",
};

static int remove_suffix(narsil_text *word, const uint16_t *const *suffixes, size_t suffix_count) {
  for (size_t i = 0; i < suffix_count; i++) {
    size_t length = narsil_rule_length(suffixes[i]);
    if (narsil_rule_ends_with(word, suffixes[i]) && word->length - length >= MIN_REMAINING_UNITS) {
      word->length -= length;
      return 1;
    }
  }
  return 0;
}

int narsil_slovenian_stem(const uint16_t *units, size_t length, narsil_text *out, narsil_normalise_scratch *scratch) {
  (void)scratch;
  int status = narsil_text_assign(out, units, length);
  if (status != NARSIL_OK || length < MIN_STEMMED_UNITS) { return status; }
  if (remove_suffix(out, noun_suffixes, sizeof(noun_suffixes) / sizeof(noun_suffixes[0]))) { return NARSIL_OK; }
  if (remove_suffix(out, verb_suffixes, sizeof(verb_suffixes) / sizeof(verb_suffixes[0]))) { return NARSIL_OK; }
  remove_suffix(out, adjective_suffixes, sizeof(adjective_suffixes) / sizeof(adjective_suffixes[0]));
  return NARSIL_OK;
}
