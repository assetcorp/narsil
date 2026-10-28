#include "internal.h"

#include <stddef.h>
#include <stdint.h>
#include <string.h>

#define VECTOR_BYTES 16U
#define WORD_BYTES 8U
#define LOW_NIBBLE_MASK 15U
#define NIBBLE_BITS 4
#define TWO_BIT_LOW_BITS UINT64_C(0x5555555555555555)

#ifdef NARSIL_NEON
#include <arm_neon.h>
#endif

#ifdef NARSIL_SSE2
#include <emmintrin.h>
#endif

#ifdef NARSIL_SSE2
static inline __m128i load_bytes(const uint8_t *source) {
  __m128i loaded;
  memcpy(&loaded, source, sizeof loaded);
  return loaded;
}

static inline uint32_t sum_of_lanes(__m128i running) {
  uint32_t lane[4];
  memcpy(lane, &running, sizeof lane);
  return lane[0] + lane[1] + lane[2] + lane[3];
}

static inline __m128i widened_products(__m128i lhs, __m128i rhs) {
  __m128i zero = _mm_setzero_si128();
  return _mm_add_epi32(_mm_madd_epi16(_mm_unpacklo_epi8(lhs, zero), _mm_unpacklo_epi8(rhs, zero)),
                       _mm_madd_epi16(_mm_unpackhi_epi8(lhs, zero), _mm_unpackhi_epi8(rhs, zero)));
}
#endif

static uint32_t nibble_pair_products(const uint8_t *first, const uint8_t *second, uint32_t bytes) {
  uint32_t total = 0;
  uint32_t offset = 0;
#ifdef NARSIL_NEON
  uint8x16_t mask = vdupq_n_u8(LOW_NIBBLE_MASK);
  uint32x4_t running = vdupq_n_u32(0);
  for (; offset + VECTOR_BYTES <= bytes; offset += VECTOR_BYTES) {
    uint8x16_t first_bytes = vld1q_u8(first + offset);
    uint8x16_t second_bytes = vld1q_u8(second + offset);
    uint8x16_t first_low = vandq_u8(first_bytes, mask);
    uint8x16_t first_high = vshrq_n_u8(first_bytes, NIBBLE_BITS);
    uint8x16_t second_low = vandq_u8(second_bytes, mask);
    uint8x16_t second_high = vshrq_n_u8(second_bytes, NIBBLE_BITS);
    uint16x8_t lower = vmlal_u8(vmull_u8(vget_low_u8(first_low), vget_low_u8(second_low)), vget_low_u8(first_high),
                                vget_low_u8(second_high));
    uint16x8_t upper = vmlal_u8(vmull_u8(vget_high_u8(first_low), vget_high_u8(second_low)), vget_high_u8(first_high),
                                vget_high_u8(second_high));
    running = vpadalq_u16(vpadalq_u16(running, lower), upper);
  }
  total = vaddvq_u32(running);
#elif defined(NARSIL_SSE2)
  __m128i mask = _mm_set1_epi8((char)LOW_NIBBLE_MASK);
  __m128i running = _mm_setzero_si128();
  for (; offset + VECTOR_BYTES <= bytes; offset += VECTOR_BYTES) {
    __m128i first_bytes = load_bytes(first + offset);
    __m128i second_bytes = load_bytes(second + offset);
    __m128i low = widened_products(_mm_and_si128(first_bytes, mask), _mm_and_si128(second_bytes, mask));
    __m128i high = widened_products(_mm_and_si128(_mm_srli_epi16(first_bytes, NIBBLE_BITS), mask),
                                    _mm_and_si128(_mm_srli_epi16(second_bytes, NIBBLE_BITS), mask));
    running = _mm_add_epi32(running, _mm_add_epi32(low, high));
  }
  total = sum_of_lanes(running);
#endif
  for (; offset < bytes; offset++) {
    total += ((uint32_t)(first[offset] & LOW_NIBBLE_MASK) * (uint32_t)(second[offset] & LOW_NIBBLE_MASK)) +
             ((uint32_t)(first[offset] >> NIBBLE_BITS) * (uint32_t)(second[offset] >> NIBBLE_BITS));
  }
  return total;
}

static inline uint32_t shared_bits(uint64_t first, uint64_t second) {
  return (uint32_t)__builtin_popcountll(first & second);
}

typedef struct {
  uint64_t first;
  uint64_t second;
} word_pair;

static inline uint32_t two_bit_products(word_pair words) {
  uint64_t first_low = words.first & TWO_BIT_LOW_BITS;
  uint64_t first_high = (words.first >> 1) & TWO_BIT_LOW_BITS;
  uint64_t second_low = words.second & TWO_BIT_LOW_BITS;
  uint64_t second_high = (words.second >> 1) & TWO_BIT_LOW_BITS;
  return shared_bits(first_low, second_low) + (2 * shared_bits(first_low, second_high)) +
         (2 * shared_bits(first_high, second_low)) + (4 * shared_bits(first_high, second_high));
}

static inline uint32_t narrow_word_products(word_pair words, uint32_t bits) {
  return bits == 1 ? shared_bits(words.first, words.second) : two_bit_products(words);
}

static uint32_t narrow_pair_products(packed_code first, const uint8_t *second) {
  uint32_t total = 0;
  uint32_t offset = 0;
  for (; offset + WORD_BYTES <= first.byte_count; offset += WORD_BYTES) {
    word_pair words = {0, 0};
    memcpy(&words.first, first.bytes + offset, sizeof words.first);
    memcpy(&words.second, second + offset, sizeof words.second);
    total += narrow_word_products(words, first.bits);
  }
  for (; offset < first.byte_count; offset++) {
    word_pair words = {first.bytes[offset], second[offset]};
    total += narrow_word_products(words, first.bits);
  }
  return total;
}

uint32_t kernel_pair_products(packed_code first, const uint8_t *second, uint32_t dimension) {
  if (first.bits == BITS_PER_BYTE) { return kernel_products_8x8(first.bytes, second, dimension); }
  if (first.bits == NIBBLE_BITS) { return nibble_pair_products(first.bytes, second, first.byte_count); }
  return narrow_pair_products(first, second);
}
