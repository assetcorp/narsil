#include "HybridNarsilCoreImpl.hpp"
#include "TypedElements.hpp"
#include "narsil_facet_merge.h"

#include <array>
#include <cmath>
#include <new>
#include <stdexcept>

namespace margelo::nitro::narsil {

namespace {

enum FacetMergeArgument : size_t {
  OFFSETS, VALUES, COUNTS, BOUNDS, RANKS, ASCENDING, LIMIT, OUT_VALUES, OUT_COUNTS, OUT_BOUND, ARGUMENT_COUNT
};

static_assert(ARGUMENT_COUNT == FACET_MERGE_ARGUMENT_COUNT);
constexpr std::array<size_t, 8> REGION_ARGUMENTS{OFFSETS, VALUES, COUNTS, BOUNDS, RANKS, OUT_VALUES, OUT_COUNTS, OUT_BOUND};

bool limitArgument(const jsi::Value& value, uint32_t& into) {
  if (!value.isNumber()) return false;
  double number = value.getNumber();
  if (!std::isfinite(number) || number < 0 || number > UINT32_MAX || std::floor(number) != number) return false;
  into = static_cast<uint32_t>(number);
  return true;
}

}

jsi::Value HybridNarsilCoreImpl::mergeFacets(jsi::Runtime& runtime, const jsi::Value&,
                                            const jsi::Value* arguments, size_t count) try {
  narsil_facet_merge_request request{};
  if (count != ARGUMENT_COUNT || !arguments[ASCENDING].isBool()) {
    return jsi::Value(-static_cast<double>(NARSIL_INVALID_ARGUMENT));
  }
  request.ascending = arguments[ASCENDING].getBool() ? 1U : 0U;
  request.has_limit = arguments[LIMIT].isNull() ? 0U : 1U;
  if (request.has_limit != 0 && !limitArgument(arguments[LIMIT], request.limit)) {
    return jsi::Value(-static_cast<double>(NARSIL_INVALID_ARGUMENT));
  }
  TypedElements views(ARGUMENT_COUNT);
  for (size_t argument : REGION_ARGUMENTS) views.prepare(runtime, argument, arguments[argument]);
  auto offsets = views.read<const uint32_t>(runtime, OFFSETS, "The facet value offsets");
  auto values = views.read<const uint32_t>(runtime, VALUES, "The facet values");
  auto counts = views.read<const uint32_t>(runtime, COUNTS, "The facet counts");
  auto bounds = views.read<const uint32_t>(runtime, BOUNDS, "The facet bounds");
  auto ranks = views.read<const uint32_t>(runtime, RANKS, "The value ranks");
  auto outValues = views.read<uint32_t>(runtime, OUT_VALUES, "The merged facet values");
  auto outCounts = views.read<uint32_t>(runtime, OUT_COUNTS, "The merged facet counts");
  auto outBound = views.read<uint32_t>(runtime, OUT_BOUND, "The merged facet bound");
  request.offsets = offsets.data;
  request.offset_count = offsets.length;
  request.values = values.data;
  request.value_count = values.length;
  request.counts = counts.data;
  request.count_count = counts.length;
  request.bounds = bounds.data;
  request.bound_count = bounds.length;
  request.ranks = ranks.data;
  request.rank_count = ranks.length;
  narsil_facet_merge_output output{outValues.data, outValues.length, outCounts.data, outCounts.length,
                                    outBound.data, outBound.length, 0};
  RuntimeState& state = stateOf(runtime);
  if (state.keywordWorkspace == nullptr) {
    narsil_workspace* created = nullptr;
    if (narsil_workspace_create(&created) != NARSIL_OK) {
      return jsi::Value(-static_cast<double>(NARSIL_OUT_OF_MEMORY));
    }
    state.keywordWorkspace.reset(created);
  }
  narsil_status status = narsil_merge_facets(state.keywordWorkspace.get(), &request, &output);
  return jsi::Value(status == NARSIL_OK ? static_cast<double>(output.count) : -static_cast<double>(status));
} catch (const std::invalid_argument&) {
  return jsi::Value(-static_cast<double>(NARSIL_INVALID_ARGUMENT));
} catch (const std::length_error&) {
  return jsi::Value(-static_cast<double>(NARSIL_INVALID_ARGUMENT));
} catch (const std::bad_alloc&) {
  return jsi::Value(-static_cast<double>(NARSIL_OUT_OF_MEMORY));
}

}
