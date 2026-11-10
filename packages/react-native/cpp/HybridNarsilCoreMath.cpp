#include "HostMemory.hpp"
#include "HybridNarsilCoreImpl.hpp"
#include "narsil_math.h"

#include <cmath>
#include <cstddef>
#include <cstdint>
#include <string>

namespace margelo::nitro::narsil {

namespace {

double* valuesOf(const MemoryView& view, const char* what, size_t* count) {
  uint8_t* bytes = bytesWithin(view.buffer, view.byteOffset, view.byteLength, what);
  size_t length = static_cast<size_t>(view.byteLength);
  if ((bytes == nullptr && length > 0) || reinterpret_cast<uintptr_t>(bytes) % alignof(double) != 0 ||
      length % sizeof(double) != 0) {
    throwInvalid(std::string(what) + " must be a Float64Array");
  }
  *count = length / sizeof(double);
  return reinterpret_cast<double*>(bytes);
}

}

double HybridNarsilCoreImpl::applyMath(double operation, const MemoryView& first, const MemoryView& second,
                                       const MemoryView& results) {
  if (!std::isfinite(operation) || operation < 0 || operation >= static_cast<double>(NARSIL_MATH_FUNCTION_COUNT) ||
      std::floor(operation) != operation) {
    throwInvalid("The maths function must be an index from the core's header");
  }
  auto function = static_cast<narsil_math_function>(static_cast<int>(operation));
  size_t firstCount = 0;
  size_t secondCount = 0;
  narsil_math_batch batch{};
  batch.first = valuesOf(first, "The arguments", &firstCount);
  const double* runs = valuesOf(second, "The second arguments", &secondCount);
  batch.results = valuesOf(results, "The results", &batch.count);
  if (firstCount != batch.count || (function == NARSIL_MATH_ATAN2 && secondCount != batch.count)) {
    throwInvalid("The arguments and the results must hold the same number of values");
  }
  batch.second = function == NARSIL_MATH_ATAN2 ? runs : nullptr;
  return static_cast<double>(narsil_math_apply(function, &batch));
}

}
