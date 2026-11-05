#include "../analysis/normalise.h"
#include "../analysis/text.h"
#include "rules.h"

#include <stddef.h>
#include <stdint.h>

#define COUNT_OF(array) (sizeof(array) / sizeof((array)[0]))

#define DELETE_UNIT(first, last) {(first), (last), 0, {0, 0}}
#define REPLACE_UNIT(first, last, unit) {(first), (last), 1, {(unit), 0}}

static const narsil_unit_substitution dagbani_substitutions[] = {
    REPLACE_UNIT(0x03B5, 0x03B5, 0x025B),
    REPLACE_UNIT(0x0511, 0x0511, 0x025B),
};

static const narsil_unit_substitution ewe_substitutions[] = {
    REPLACE_UNIT(0x00F0, 0x00F0, 0x0256),
};

static const narsil_unit_substitution german_substitutions[] = {
    {0x00DF, 0x00DF, 2, {0x0073, 0x0073}},
};

static const narsil_unit_substitution guarani_substitutions[] = {
    REPLACE_UNIT(0xA78C, 0xA78C, 0x0027),
};

static const narsil_unit_substitution hebrew_substitutions[] = {
    DELETE_UNIT(0x0591, 0x05C7),
};

static const narsil_unit_substitution persian_substitutions[] = {
    REPLACE_UNIT(0x064A, 0x064A, 0x06CC), REPLACE_UNIT(0x0649, 0x0649, 0x06CC), REPLACE_UNIT(0x0643, 0x0643, 0x06A9),
    DELETE_UNIT(0x0640, 0x0640),          DELETE_UNIT(0x064B, 0x0652),
};

static const narsil_unit_substitution romanian_substitutions[] = {
    REPLACE_UNIT(0x015F, 0x015F, 0x0219),
    REPLACE_UNIT(0x0163, 0x0163, 0x021B),
};

static const narsil_unit_substitution serbian_substitutions[] = {
    REPLACE_UNIT(0x0430, 0x0430, 0x0061),  REPLACE_UNIT(0x0431, 0x0431, 0x0062), REPLACE_UNIT(0x0432, 0x0432, 0x0076),
    REPLACE_UNIT(0x0433, 0x0433, 0x0067),  REPLACE_UNIT(0x0434, 0x0434, 0x0064), REPLACE_UNIT(0x0435, 0x0435, 0x0065),
    REPLACE_UNIT(0x0436, 0x0436, 0x017E),  REPLACE_UNIT(0x0437, 0x0437, 0x007A), REPLACE_UNIT(0x0438, 0x0438, 0x0069),
    REPLACE_UNIT(0x043A, 0x043A, 0x006B),  REPLACE_UNIT(0x043B, 0x043B, 0x006C), REPLACE_UNIT(0x043C, 0x043C, 0x006D),
    REPLACE_UNIT(0x043D, 0x043D, 0x006E),  REPLACE_UNIT(0x043E, 0x043E, 0x006F), REPLACE_UNIT(0x043F, 0x043F, 0x0070),
    REPLACE_UNIT(0x0440, 0x0440, 0x0072),  REPLACE_UNIT(0x0441, 0x0441, 0x0073), REPLACE_UNIT(0x0442, 0x0442, 0x0074),
    REPLACE_UNIT(0x0443, 0x0443, 0x0075),  REPLACE_UNIT(0x0444, 0x0444, 0x0066), REPLACE_UNIT(0x0445, 0x0445, 0x0068),
    REPLACE_UNIT(0x0446, 0x0446, 0x0063),  REPLACE_UNIT(0x0447, 0x0447, 0x010D), REPLACE_UNIT(0x0448, 0x0448, 0x0161),
    REPLACE_UNIT(0x0452, 0x0452, 0x0111),  REPLACE_UNIT(0x0458, 0x0458, 0x006A), {0x0459, 0x0459, 2, {0x006C, 0x006A}},
    {0x045A, 0x045A, 2, {0x006E, 0x006A}}, REPLACE_UNIT(0x045B, 0x045B, 0x0107), {0x045F, 0x045F, 2, {0x0064, 0x017E}},
};

static const narsil_unit_substitution sinhala_substitutions[] = {
    DELETE_UNIT(0x200D, 0x200D),
};

static const narsil_unit_substitution telugu_substitutions[] = {
    DELETE_UNIT(0x200C, 0x200C),
};

static const narsil_unit_substitution twi_substitutions[] = {
    REPLACE_UNIT(0x03B5, 0x03B5, 0x025B),
    REPLACE_UNIT(0x037B, 0x037B, 0x0254),
    REPLACE_UNIT(0x2184, 0x2184, 0x0254),
    REPLACE_UNIT(0x05DB, 0x05DB, 0x0254),
};

int narsil_dagbani_normalise(const uint16_t *units, size_t length, narsil_text *out,
                             narsil_normalise_scratch *scratch) {
  (void)scratch;
  return narsil_substitute_units(units, length, dagbani_substitutions, COUNT_OF(dagbani_substitutions), out);
}

int narsil_ewe_normalise(const uint16_t *units, size_t length, narsil_text *out, narsil_normalise_scratch *scratch) {
  (void)scratch;
  return narsil_substitute_units(units, length, ewe_substitutions, COUNT_OF(ewe_substitutions), out);
}

int narsil_german_normalise(const uint16_t *units, size_t length, narsil_text *out, narsil_normalise_scratch *scratch) {
  (void)scratch;
  return narsil_substitute_units(units, length, german_substitutions, COUNT_OF(german_substitutions), out);
}

int narsil_guarani_normalise(const uint16_t *units, size_t length, narsil_text *out,
                             narsil_normalise_scratch *scratch) {
  (void)scratch;
  return narsil_substitute_units(units, length, guarani_substitutions, COUNT_OF(guarani_substitutions), out);
}

int narsil_hebrew_normalise(const uint16_t *units, size_t length, narsil_text *out, narsil_normalise_scratch *scratch) {
  (void)scratch;
  return narsil_substitute_units(units, length, hebrew_substitutions, COUNT_OF(hebrew_substitutions), out);
}

int narsil_persian_normalise(const uint16_t *units, size_t length, narsil_text *out,
                             narsil_normalise_scratch *scratch) {
  (void)scratch;
  return narsil_substitute_units(units, length, persian_substitutions, COUNT_OF(persian_substitutions), out);
}

int narsil_romanian_normalise(const uint16_t *units, size_t length, narsil_text *out,
                              narsil_normalise_scratch *scratch) {
  (void)scratch;
  return narsil_substitute_units(units, length, romanian_substitutions, COUNT_OF(romanian_substitutions), out);
}

int narsil_serbian_normalise(const uint16_t *units, size_t length, narsil_text *out,
                             narsil_normalise_scratch *scratch) {
  (void)scratch;
  return narsil_substitute_units(units, length, serbian_substitutions, COUNT_OF(serbian_substitutions), out);
}

int narsil_sinhala_normalise(const uint16_t *units, size_t length, narsil_text *out,
                             narsil_normalise_scratch *scratch) {
  (void)scratch;
  return narsil_substitute_units(units, length, sinhala_substitutions, COUNT_OF(sinhala_substitutions), out);
}

int narsil_telugu_normalise(const uint16_t *units, size_t length, narsil_text *out, narsil_normalise_scratch *scratch) {
  (void)scratch;
  return narsil_substitute_units(units, length, telugu_substitutions, COUNT_OF(telugu_substitutions), out);
}

int narsil_twi_normalise(const uint16_t *units, size_t length, narsil_text *out, narsil_normalise_scratch *scratch) {
  (void)scratch;
  return narsil_substitute_units(units, length, twi_substitutions, COUNT_OF(twi_substitutions), out);
}
