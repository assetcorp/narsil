#include "internal.h"

#include <math.h>
#include <stddef.h>
#include <stdint.h>
#include <string.h>

#define LANE_WIDTH 4U

static inline float component(const float *values, size_t index) {
  float value = 0;
  memcpy(&value, (const unsigned char *)values + (index * sizeof(float)), sizeof(value));
  return value;
}
#define UNROLLED_LANES 4U
#define UNROLLED_WIDTH (LANE_WIDTH * UNROLLED_LANES)

#ifdef NARSIL_NEON
#include <arm_neon.h>
typedef float32x4_t lanes;
static inline lanes lanes_zero(void) { return vdupq_n_f32(0); }
static inline lanes lanes_load(const float *source) { return vld1q_f32(source); }
static inline lanes lanes_add(lanes lhs, lanes rhs) { return vaddq_f32(lhs, rhs); }
static inline lanes lanes_sub(lanes lhs, lanes rhs) { return vsubq_f32(lhs, rhs); }
static inline lanes lanes_mul(lanes lhs, lanes rhs) { return vmulq_f32(lhs, rhs); }
static inline float lanes_sum_in_pairs(lanes values) {
  return (vgetq_lane_f32(values, 0) + vgetq_lane_f32(values, 1)) +
         (vgetq_lane_f32(values, 2) + vgetq_lane_f32(values, 3));
}
#elif defined(NARSIL_SSE2)
#include <emmintrin.h>
#ifdef NARSIL_AVX2
#include <cpuid.h>
#include <immintrin.h>
#include <stdatomic.h>
#endif
typedef __m128 lanes;
static inline lanes lanes_zero(void) { return _mm_setzero_ps(); }
static inline lanes lanes_load(const float *source) { return _mm_loadu_ps(source); }
static inline lanes lanes_add(lanes lhs, lanes rhs) { return _mm_add_ps(lhs, rhs); }
static inline lanes lanes_sub(lanes lhs, lanes rhs) { return _mm_sub_ps(lhs, rhs); }
static inline lanes lanes_mul(lanes lhs, lanes rhs) { return _mm_mul_ps(lhs, rhs); }
static inline float lanes_sum_in_pairs(lanes values) {
  float lane[LANE_WIDTH];
  _mm_storeu_ps(lane, values);
  return (lane[0] + lane[1]) + (lane[2] + lane[3]);
}
#else
typedef struct {
  float lane[LANE_WIDTH];
} lanes;
static inline lanes lanes_zero(void) { return (lanes){{0, 0, 0, 0}}; }
static inline lanes lanes_load(const float *source) {
  return (lanes){{component(source, 0), component(source, 1), component(source, 2), component(source, 3)}};
}
static inline lanes lanes_add(lanes lhs, lanes rhs) {
  return (lanes){
      {lhs.lane[0] + rhs.lane[0], lhs.lane[1] + rhs.lane[1], lhs.lane[2] + rhs.lane[2], lhs.lane[3] + rhs.lane[3]}};
}
static inline lanes lanes_sub(lanes lhs, lanes rhs) {
  return (lanes){
      {lhs.lane[0] - rhs.lane[0], lhs.lane[1] - rhs.lane[1], lhs.lane[2] - rhs.lane[2], lhs.lane[3] - rhs.lane[3]}};
}
static inline lanes lanes_mul(lanes lhs, lanes rhs) {
  return (lanes){
      {lhs.lane[0] * rhs.lane[0], lhs.lane[1] * rhs.lane[1], lhs.lane[2] * rhs.lane[2], lhs.lane[3] * rhs.lane[3]}};
}
static inline float lanes_sum_in_pairs(lanes values) {
  return (values.lane[0] + values.lane[1]) + (values.lane[2] + values.lane[3]);
}
#endif

static inline uint32_t whole_steps(uint32_t count, uint32_t width) { return count - (count % width); }

static inline lanes lane_product(const float *lhs, const float *rhs, size_t lane) {
  return lanes_mul(lanes_load(lhs + (lane * LANE_WIDTH)), lanes_load(rhs + (lane * LANE_WIDTH)));
}

typedef struct {
  lanes sums[UNROLLED_LANES];
  uint32_t offset;
} unrolled_dot;

static inline float finish_dot(const float *lhs, const float *rhs, uint32_t dimension, unrolled_dot dot) {
  uint32_t lanes_end = whole_steps(dimension, LANE_WIDTH);
  uint32_t offset = dot.offset;
  lanes first = dot.sums[0];
  for (; offset < lanes_end; offset += LANE_WIDTH) {
    first = lanes_add(first, lane_product(lhs + offset, rhs + offset, 0));
  }
  float sum = lanes_sum_in_pairs(lanes_add(lanes_add(first, dot.sums[1]), lanes_add(dot.sums[2], dot.sums[3])));
  for (; offset < dimension; offset++) { sum = sum + (component(lhs, offset) * component(rhs, offset)); }
  return sum;
}

#ifdef NARSIL_AVX2
#define CPUID_FEATURES_LEAF 1U
#define CPUID_EXTENDED_FEATURES_LEAF 7U
#define XCR0_SSE_AND_AVX_STATE 6U
#define WIDE_LANE_WIDTH 8U
#define AVX2_UNKNOWN 0
#define AVX2_ABSENT 1
#define AVX2_PRESENT 2

static atomic_int avx2_state = AVX2_UNKNOWN;

static uint32_t enabled_register_state(void) {
  uint32_t low = 0;
  uint32_t high = 0;
  __asm__ volatile("xgetbv" : "=a"(low), "=d"(high) : "c"(0));
  (void)high;
  return low;
}

static int processor_runs_avx2(void) {
  unsigned int eax = 0;
  unsigned int ebx = 0;
  unsigned int ecx = 0;
  unsigned int edx = 0;
  if (__get_cpuid_max(0, NULL) < CPUID_EXTENDED_FEATURES_LEAF) { return 0; }
  if (!__get_cpuid(CPUID_FEATURES_LEAF, &eax, &ebx, &ecx, &edx)) { return 0; }
  if ((ecx & bit_OSXSAVE) == 0 || (ecx & bit_AVX) == 0) { return 0; }
  if ((enabled_register_state() & XCR0_SSE_AND_AVX_STATE) != XCR0_SSE_AND_AVX_STATE) { return 0; }
  __cpuid_count(CPUID_EXTENDED_FEATURES_LEAF, 0, eax, ebx, ecx, edx);
  return (ebx & bit_AVX2) != 0;
}

int uses_hardware_avx2(void) {
  int state = atomic_load_explicit(&avx2_state, memory_order_relaxed);
  if (state == AVX2_UNKNOWN) {
    state = processor_runs_avx2() ? AVX2_PRESENT : AVX2_ABSENT;
    atomic_store_explicit(&avx2_state, state, memory_order_relaxed);
  }
  return state == AVX2_PRESENT;
}

__attribute__((target("avx2"))) static unrolled_dot unrolled_dot_of(__m256 first_half, __m256 second_half,
                                                                    uint32_t offset) {
  unrolled_dot dot = {{_mm256_castps256_ps128(first_half), _mm256_extractf128_ps(first_half, 1),
                       _mm256_castps256_ps128(second_half), _mm256_extractf128_ps(second_half, 1)},
                      offset};
  return dot;
}

__attribute__((target("avx2"))) static float dot_in_wide_lanes(const float *lhs, const float *rhs, uint32_t dimension) {
  uint32_t unrolled_end = whole_steps(dimension, UNROLLED_WIDTH);
  __m256 first_half = _mm256_setzero_ps();
  __m256 second_half = _mm256_setzero_ps();
  uint32_t offset = 0;
  for (; offset < unrolled_end; offset += UNROLLED_WIDTH) {
    first_half = _mm256_add_ps(first_half, _mm256_mul_ps(_mm256_loadu_ps(lhs + offset), _mm256_loadu_ps(rhs + offset)));
    second_half = _mm256_add_ps(second_half, _mm256_mul_ps(_mm256_loadu_ps(lhs + offset + WIDE_LANE_WIDTH),
                                                           _mm256_loadu_ps(rhs + offset + WIDE_LANE_WIDTH)));
  }
  return finish_dot(lhs, rhs, dimension, unrolled_dot_of(first_half, second_half, offset));
}

__attribute__((target("avx2"))) static void dot_batch_in_wide_lanes(const float *query, const float *const *vectors,
                                                                    uint32_t dimension, float *dots) {
  uint32_t unrolled_end = whole_steps(dimension, UNROLLED_WIDTH);
  __m256 first_half0 = _mm256_setzero_ps();
  __m256 second_half0 = _mm256_setzero_ps();
  __m256 first_half1 = _mm256_setzero_ps();
  __m256 second_half1 = _mm256_setzero_ps();
  __m256 first_half2 = _mm256_setzero_ps();
  __m256 second_half2 = _mm256_setzero_ps();
  __m256 first_half3 = _mm256_setzero_ps();
  __m256 second_half3 = _mm256_setzero_ps();
  uint32_t offset = 0;
  for (; offset < unrolled_end; offset += UNROLLED_WIDTH) {
    __m256 query_first = _mm256_loadu_ps(query + offset);
    __m256 query_second = _mm256_loadu_ps(query + offset + WIDE_LANE_WIDTH);
    first_half0 = _mm256_add_ps(first_half0, _mm256_mul_ps(query_first, _mm256_loadu_ps(vectors[0] + offset)));
    second_half0 = _mm256_add_ps(second_half0,
                                 _mm256_mul_ps(query_second, _mm256_loadu_ps(vectors[0] + offset + WIDE_LANE_WIDTH)));
    first_half1 = _mm256_add_ps(first_half1, _mm256_mul_ps(query_first, _mm256_loadu_ps(vectors[1] + offset)));
    second_half1 = _mm256_add_ps(second_half1,
                                 _mm256_mul_ps(query_second, _mm256_loadu_ps(vectors[1] + offset + WIDE_LANE_WIDTH)));
    first_half2 = _mm256_add_ps(first_half2, _mm256_mul_ps(query_first, _mm256_loadu_ps(vectors[2] + offset)));
    second_half2 = _mm256_add_ps(second_half2,
                                 _mm256_mul_ps(query_second, _mm256_loadu_ps(vectors[2] + offset + WIDE_LANE_WIDTH)));
    first_half3 = _mm256_add_ps(first_half3, _mm256_mul_ps(query_first, _mm256_loadu_ps(vectors[3] + offset)));
    second_half3 = _mm256_add_ps(second_half3,
                                 _mm256_mul_ps(query_second, _mm256_loadu_ps(vectors[3] + offset + WIDE_LANE_WIDTH)));
  }
  dots[0] = finish_dot(query, vectors[0], dimension, unrolled_dot_of(first_half0, second_half0, offset));
  dots[1] = finish_dot(query, vectors[1], dimension, unrolled_dot_of(first_half1, second_half1, offset));
  dots[2] = finish_dot(query, vectors[2], dimension, unrolled_dot_of(first_half2, second_half2, offset));
  dots[3] = finish_dot(query, vectors[3], dimension, unrolled_dot_of(first_half3, second_half3, offset));
}
#endif

static float dot_in_narrow_lanes(const float *lhs, const float *rhs, uint32_t dimension) {
  uint32_t unrolled_end = whole_steps(dimension, UNROLLED_WIDTH);
  lanes sum0 = lanes_zero();
  lanes sum1 = lanes_zero();
  lanes sum2 = lanes_zero();
  lanes sum3 = lanes_zero();
  uint32_t offset = 0;
  for (; offset < unrolled_end; offset += UNROLLED_WIDTH) {
    sum0 = lanes_add(sum0, lane_product(lhs + offset, rhs + offset, 0));
    sum1 = lanes_add(sum1, lane_product(lhs + offset, rhs + offset, 1));
    sum2 = lanes_add(sum2, lane_product(lhs + offset, rhs + offset, 2));
    sum3 = lanes_add(sum3, lane_product(lhs + offset, rhs + offset, 3));
  }
  unrolled_dot dot = {{sum0, sum1, sum2, sum3}, offset};
  return finish_dot(lhs, rhs, dimension, dot);
}

float kernel_dot(const float *lhs, const float *rhs, uint32_t dimension) {
#ifdef NARSIL_AVX2
  if (uses_hardware_avx2()) { return dot_in_wide_lanes(lhs, rhs, dimension); }
#endif
  return dot_in_narrow_lanes(lhs, rhs, dimension);
}

void kernel_dot_batch(const float *query, const float *const *vectors, uint32_t dimension, float *dots) {
#ifdef NARSIL_AVX2
  if (uses_hardware_avx2()) {
    dot_batch_in_wide_lanes(query, vectors, dimension, dots);
    return;
  }
#endif
  for (uint32_t i = 0; i < DOT_BATCH; i++) { dots[i] = dot_in_narrow_lanes(query, vectors[i], dimension); }
}

float kernel_squared_distance(const float *lhs, const float *rhs, uint32_t dimension) {
  uint32_t lanes_end = whole_steps(dimension, LANE_WIDTH);
  lanes running = lanes_zero();
  uint32_t offset = 0;
  for (; offset < lanes_end; offset += LANE_WIDTH) {
    lanes difference = lanes_sub(lanes_load(lhs + offset), lanes_load(rhs + offset));
    running = lanes_add(running, lanes_mul(difference, difference));
  }
  float sum = lanes_sum_in_pairs(running);
  for (; offset < dimension; offset++) {
    float difference = component(lhs, offset) - component(rhs, offset);
    sum = sum + (difference * difference);
  }
  return sum;
}

float kernel_magnitude(const float *values, uint32_t dimension) {
  uint32_t lanes_end = whole_steps(dimension, LANE_WIDTH);
  lanes running = lanes_zero();
  uint32_t offset = 0;
  for (; offset < lanes_end; offset += LANE_WIDTH) {
    lanes loaded = lanes_load(values + offset);
    running = lanes_add(running, lanes_mul(loaded, loaded));
  }
  float sum = lanes_sum_in_pairs(running);
  for (; offset < dimension; offset++) { sum = sum + (values[offset] * values[offset]); }
  return sqrtf(sum);
}
