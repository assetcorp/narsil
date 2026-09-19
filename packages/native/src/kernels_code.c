#include "internal.h"

#include <stddef.h>
#include <stdint.h>
#include <string.h>

#define VECTOR_BYTES 16U
#define WORD_BYTES 8U
#define LOW_NIBBLE_MASK 15U
#define NIBBLE_BITS 4
#define TWO_BIT_LOW_BITS UINT64_C(0x5555555555555555)

#ifdef NARSIL_PORTABLE_KERNELS
#elif defined(__aarch64__) || defined(_M_ARM64)
#include <arm_neon.h>
#define CODE_KERNELS_NEON 1
#elif defined(__SSE2__) || defined(_M_X64)
#include <emmintrin.h>
#define CODE_KERNELS_SSE2 1
#endif

#ifdef CODE_KERNELS_SSE2
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
#endif

uint32_t kernel_products_8x8(const uint8_t *document, const uint8_t *query, uint32_t dimension) {
  uint32_t total = 0;
  uint32_t offset = 0;
#ifdef CODE_KERNELS_NEON
  uint32x4_t running = vdupq_n_u32(0);
  for (; offset + VECTOR_BYTES <= dimension; offset += VECTOR_BYTES) {
    uint8x16_t document_bytes = vld1q_u8(document + offset);
    uint8x16_t query_bytes = vld1q_u8(query + offset);
    running = vpadalq_u16(running, vmull_u8(vget_low_u8(document_bytes), vget_low_u8(query_bytes)));
    running = vpadalq_u16(running, vmull_u8(vget_high_u8(document_bytes), vget_high_u8(query_bytes)));
  }
  total = vaddvq_u32(running);
#elif defined(CODE_KERNELS_SSE2)
  __m128i zero = _mm_setzero_si128();
  __m128i running = zero;
  for (; offset + VECTOR_BYTES <= dimension; offset += VECTOR_BYTES) {
    __m128i document_bytes = load_bytes(document + offset);
    __m128i query_bytes = load_bytes(query + offset);
    __m128i low = _mm_mullo_epi16(_mm_unpacklo_epi8(document_bytes, zero), _mm_unpacklo_epi8(query_bytes, zero));
    __m128i high = _mm_mullo_epi16(_mm_unpackhi_epi8(document_bytes, zero), _mm_unpackhi_epi8(query_bytes, zero));
    running = _mm_add_epi32(running, _mm_add_epi32(_mm_unpacklo_epi16(low, zero), _mm_unpackhi_epi16(low, zero)));
    running = _mm_add_epi32(running, _mm_add_epi32(_mm_unpacklo_epi16(high, zero), _mm_unpackhi_epi16(high, zero)));
  }
  total = sum_of_lanes(running);
#endif
  for (; offset < dimension; offset++) { total += (uint32_t)document[offset] * (uint32_t)query[offset]; }
  return total;
}

uint32_t kernel_products_4x4(const uint8_t *document, const uint8_t *low, const uint8_t *high, uint32_t bytes) {
  uint32_t total = 0;
  uint32_t offset = 0;
#ifdef CODE_KERNELS_NEON
  uint8x16_t mask = vdupq_n_u8(LOW_NIBBLE_MASK);
  uint32x4_t running = vdupq_n_u32(0);
  for (; offset + VECTOR_BYTES <= bytes; offset += VECTOR_BYTES) {
    uint8x16_t document_bytes = vld1q_u8(document + offset);
    uint8x16_t document_low = vandq_u8(document_bytes, mask);
    uint8x16_t document_high = vshrq_n_u8(document_bytes, NIBBLE_BITS);
    uint8x16_t low_bytes = vld1q_u8(low + offset);
    uint8x16_t high_bytes = vld1q_u8(high + offset);
    uint16x8_t first = vmlal_u8(vmull_u8(vget_low_u8(document_low), vget_low_u8(low_bytes)), vget_low_u8(document_high),
                                vget_low_u8(high_bytes));
    uint16x8_t second = vmlal_u8(vmull_u8(vget_high_u8(document_low), vget_high_u8(low_bytes)),
                                 vget_high_u8(document_high), vget_high_u8(high_bytes));
    running = vpadalq_u16(vpadalq_u16(running, first), second);
  }
  total = vaddvq_u32(running);
#elif defined(CODE_KERNELS_SSE2)
  __m128i zero = _mm_setzero_si128();
  __m128i mask = _mm_set1_epi8((char)LOW_NIBBLE_MASK);
  __m128i running = zero;
  for (; offset + VECTOR_BYTES <= bytes; offset += VECTOR_BYTES) {
    __m128i document_bytes = load_bytes(document + offset);
    __m128i low_bytes = load_bytes(low + offset);
    __m128i high_bytes = load_bytes(high + offset);
    __m128i document_low = _mm_and_si128(document_bytes, mask);
    __m128i document_high = _mm_and_si128(_mm_srli_epi16(document_bytes, NIBBLE_BITS), mask);
    __m128i even =
        _mm_add_epi32(_mm_madd_epi16(_mm_unpacklo_epi8(document_low, zero), _mm_unpacklo_epi8(low_bytes, zero)),
                      _mm_madd_epi16(_mm_unpackhi_epi8(document_low, zero), _mm_unpackhi_epi8(low_bytes, zero)));
    __m128i odd =
        _mm_add_epi32(_mm_madd_epi16(_mm_unpacklo_epi8(document_high, zero), _mm_unpacklo_epi8(high_bytes, zero)),
                      _mm_madd_epi16(_mm_unpackhi_epi8(document_high, zero), _mm_unpackhi_epi8(high_bytes, zero)));
    running = _mm_add_epi32(running, _mm_add_epi32(even, odd));
  }
  total = sum_of_lanes(running);
#endif
  for (; offset < bytes; offset++) {
    total += ((uint32_t)(document[offset] & LOW_NIBBLE_MASK) * low[offset]) +
             ((uint32_t)(document[offset] >> NIBBLE_BITS) * high[offset]);
  }
  return total;
}

static inline uint32_t weighted_bits(uint64_t low, uint64_t high, uint64_t plane) {
  return (uint32_t)__builtin_popcountll(low & plane) + (2 * (uint32_t)__builtin_popcountll(high & plane));
}

uint32_t kernel_products_bits(packed_code document, const uint8_t *planes) {
  uint64_t low_mask = document.bits == 2 ? TWO_BIT_LOW_BITS : ~UINT64_C(0);
  uint64_t high_mask = document.bits == 2 ? TWO_BIT_LOW_BITS : 0;
  uint32_t total = 0;
  uint32_t offset = 0;
  for (; offset + WORD_BYTES <= document.byte_count; offset += WORD_BYTES) {
    uint64_t word = 0;
    memcpy(&word, document.bytes + offset, sizeof word);
    uint64_t low = word & low_mask;
    uint64_t high = (word >> 1) & high_mask;
    for (uint32_t plane = 0; plane < QUERY_PLANES; plane++) {
      uint64_t query = 0;
      memcpy(&query, planes + ((size_t)plane * document.byte_count) + offset, sizeof query);
      total += weighted_bits(low, high, query) << plane;
    }
  }
  for (; offset < document.byte_count; offset++) {
    uint64_t low = document.bytes[offset] & low_mask;
    uint64_t high = ((uint64_t)document.bytes[offset] >> 1) & high_mask;
    for (uint32_t plane = 0; plane < QUERY_PLANES; plane++) {
      total += weighted_bits(low, high, planes[((size_t)plane * document.byte_count) + offset]) << plane;
    }
  }
  return total;
}
