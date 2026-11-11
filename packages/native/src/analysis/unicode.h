#ifndef NARSIL_ANALYSIS_UNICODE_H
#define NARSIL_ANALYSIS_UNICODE_H

#include <stdint.h>

#define NARSIL_UNICODE_COMBINING_CLASS_MASK 0xFFU
#define NARSIL_UNICODE_LETTER (1U << 8)
#define NARSIL_UNICODE_MARK (1U << 9)
#define NARSIL_UNICODE_NUMBER (1U << 10)
#define NARSIL_UNICODE_FORMAT (1U << 11)
#define NARSIL_UNICODE_CASED (1U << 12)
#define NARSIL_UNICODE_CASE_IGNORABLE (1U << 13)
#define NARSIL_UNICODE_LOWERCASE_MAPPING (1U << 14)
#define NARSIL_UNICODE_DECOMPOSES (1U << 15)
#define NARSIL_UNICODE_COMPOSES_SECOND (1U << 16)
#define NARSIL_UNICODE_COMPOSITION_EXCLUDED (1U << 17)
#define NARSIL_UNICODE_SCRIPT_SHIFT 20
#define NARSIL_UNICODE_SCRIPT_MASK 0xFU

#define NARSIL_UNICODE_SCRIPT_OTHER 0
#define NARSIL_UNICODE_SCRIPT_HAN 1
#define NARSIL_UNICODE_SCRIPT_HIRAGANA 2
#define NARSIL_UNICODE_SCRIPT_KATAKANA 3
#define NARSIL_UNICODE_SCRIPT_HANGUL 4
#define NARSIL_UNICODE_SCRIPT_THAI 5
#define NARSIL_UNICODE_SCRIPT_LAO 6
#define NARSIL_UNICODE_SCRIPT_KHMER 7
#define NARSIL_UNICODE_SCRIPT_MYANMAR 8

#define NARSIL_UNICODE_RUN_INDEX_BITS 8
#define NARSIL_UNICODE_MAX_CODE_POINT 0x10FFFFU
#define NARSIL_UNICODE_MAX_DECOMPOSITION 4
#define NARSIL_UNICODE_NO_COMPOSITE 0U

extern const uint32_t narsil_unicode_property_values[];
extern const uint32_t narsil_unicode_property_values_length;
extern const uint32_t narsil_unicode_property_runs[];
extern const uint32_t narsil_unicode_property_runs_length;
extern const uint32_t narsil_unicode_lowercase[];
extern const uint32_t narsil_unicode_lowercase_length;
extern const uint32_t narsil_unicode_special_lowercase[];
extern const uint32_t narsil_unicode_special_lowercase_length;
extern const uint32_t narsil_unicode_decompositions[];
extern const uint32_t narsil_unicode_decompositions_length;

int narsil_unicode_prepare(void);
uint32_t narsil_unicode_properties(uint32_t code_point);
uint32_t narsil_unicode_combining_class(uint32_t code_point);
uint32_t narsil_unicode_script(uint32_t code_point);
uint32_t narsil_unicode_lowercase_of(uint32_t code_point, uint32_t *second);
uint32_t narsil_unicode_decompose(uint32_t code_point, uint32_t *out);
uint32_t narsil_unicode_compose(uint32_t first, uint32_t second);

#endif
