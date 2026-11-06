#include "../../include/narsil_core.h"
#include "../analysis/normalise.h"
#include "../analysis/text.h"
#include "../analysis/unicode.h"
#include "rules.h"

#include <stddef.h>
#include <stdint.h>

#define ZERO_WIDTH_NON_JOINER 0x200CU
#define ZERO_WIDTH_JOINER 0x200DU

#define DEVANAGARI_NGA 0x0919U
#define DEVANAGARI_NYA 0x091EU
#define DEVANAGARI_NNA 0x0923U
#define DEVANAGARI_NA 0x0928U
#define DEVANAGARI_MA 0x092EU
#define DEVANAGARI_KA 0x0915U
#define DEVANAGARI_VIRAMA 0x094DU
#define DEVANAGARI_ANUSVARA 0x0902U

#define MALAYALAM_VIRAMA 0x0D4DU

#define ARABIC_TEH_MARBUTA 0x0629U
#define ARABIC_REH 0x0631U
#define ARABIC_TATWEEL 0x0640U
#define ARABIC_KAF 0x0643U
#define ARABIC_HEH 0x0647U
#define ARABIC_DOTLESS_YEH 0x0649U
#define ARABIC_YEH 0x064AU
#define ARABIC_FATHATAN 0x064BU
#define ARABIC_SUKUN 0x0652U
#define ARABIC_RREH_ABOVE 0x0692U
#define ARABIC_RREH 0x0695U
#define ARABIC_KEHEH 0x06A9U
#define ARABIC_HEH_DOACHASHMEE 0x06BEU
#define ARABIC_FARSI_YEH 0x06CCU
#define ARABIC_AE 0x06D5U

typedef struct {
  uint16_t base;
  uint16_t chillu;
} malayalam_chillu;

static const malayalam_chillu malayalam_chillus[] = {
    {0x0D23, 0x0D7A}, {0x0D28, 0x0D7B}, {0x0D30, 0x0D7C}, {0x0D32, 0x0D7D}, {0x0D33, 0x0D7E}, {0x0D15, 0x0D7F},
};

static int is_devanagari_nasal(uint16_t unit) {
  return unit == DEVANAGARI_NGA || unit == DEVANAGARI_NYA || unit == DEVANAGARI_NNA || unit == DEVANAGARI_NA ||
         unit == DEVANAGARI_MA;
}

static int is_devanagari_stop(uint16_t unit) { return unit >= DEVANAGARI_KA && unit <= DEVANAGARI_MA; }

int narsil_hindi_normalise(const uint16_t *units, size_t length, narsil_text *out, narsil_normalise_scratch *scratch) {
  (void)scratch;
  out->length = 0;
  int status = narsil_text_reserve(out, length + 1);
  size_t index = 0;
  while (index < length && status == NARSIL_OK) {
    if (index + 2 < length && is_devanagari_nasal(units[index]) && units[index + 1] == DEVANAGARI_VIRAMA &&
        is_devanagari_stop(units[index + 2])) {
      status = narsil_text_push(out, DEVANAGARI_ANUSVARA);
      index += 2;
    } else {
      status = narsil_text_push(out, units[index]);
      index++;
    }
  }
  return status;
}

static uint16_t malayalam_chillu_of(uint16_t base) {
  for (size_t i = 0; i < sizeof(malayalam_chillus) / sizeof(malayalam_chillus[0]); i++) {
    if (malayalam_chillus[i].base == base) { return malayalam_chillus[i].chillu; }
  }
  return 0;
}

int narsil_malayalam_normalise(const uint16_t *units, size_t length, narsil_text *out,
                               narsil_normalise_scratch *scratch) {
  (void)scratch;
  out->length = 0;
  int status = narsil_text_reserve(out, length + 1);
  size_t index = 0;
  while (index < length && status == NARSIL_OK) {
    uint16_t unit = units[index];
    uint16_t chillu = malayalam_chillu_of(unit);
    if (chillu != 0 && index + 2 < length && units[index + 1] == MALAYALAM_VIRAMA &&
        units[index + 2] == ZERO_WIDTH_JOINER) {
      status = narsil_text_push(out, chillu);
      index += 3;
    } else {
      if (unit != ZERO_WIDTH_NON_JOINER && unit != ZERO_WIDTH_JOINER) { status = narsil_text_push(out, unit); }
      index++;
    }
  }
  return status;
}

static int sorani_drops(uint32_t code_point) {
  if (code_point == ARABIC_TATWEEL || (code_point >= ARABIC_FATHATAN && code_point <= ARABIC_SUKUN)) { return 1; }
  return (narsil_unicode_properties(code_point) & NARSIL_UNICODE_FORMAT) != 0;
}

static uint32_t sorani_rewrite(uint32_t code_point, int first, int last) {
  switch (code_point) {
    case ARABIC_YEH:
    case ARABIC_DOTLESS_YEH:
      return ARABIC_FARSI_YEH;
    case ARABIC_KAF:
      return ARABIC_KEHEH;
    case ARABIC_HEH:
      return last ? ARABIC_AE : ARABIC_HEH;
    case ARABIC_TEH_MARBUTA:
      return ARABIC_AE;
    case ARABIC_HEH_DOACHASHMEE:
      return ARABIC_HEH;
    case ARABIC_REH:
      return first ? ARABIC_RREH : ARABIC_REH;
    case ARABIC_RREH_ABOVE:
      return ARABIC_RREH;
    default:
      return code_point;
  }
}

int narsil_sorani_normalise(const uint16_t *units, size_t length, narsil_text *out, narsil_normalise_scratch *scratch) {
  (void)scratch;
  out->length = 0;
  int status = narsil_text_reserve(out, length + 1);
  size_t index = 0;
  while (index < length && status == NARSIL_OK) {
    uint32_t code_point = narsil_decode_next(units, length, &index);
    if (code_point == ZERO_WIDTH_NON_JOINER) {
      if (out->length > 0 && out->units[out->length - 1] == ARABIC_HEH) { out->units[out->length - 1] = ARABIC_AE; }
    } else if (!sorani_drops(code_point)) {
      status = narsil_text_push_code_point(out, sorani_rewrite(code_point, out->length == 0, index == length));
    }
  }
  return status;
}
