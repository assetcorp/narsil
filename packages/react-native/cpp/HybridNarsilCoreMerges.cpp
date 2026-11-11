#include "HybridNarsilCoreImpl.hpp"
#include "TypedElements.hpp"
#include "narsil_merges.h"

#include <cmath>
#include <new>
#include <stdexcept>

namespace margelo::nitro::narsil {

namespace {

enum MergeArgument : size_t {
  MERGE_OFFSETS,
  MERGE_SCORES,
  MERGE_RANKS,
  MERGE_LIMIT,
  MERGE_LISTS,
  MERGE_INDICES,
  MERGE_ARGUMENT_COUNT
};

static_assert(MERGE_ARGUMENT_COUNT == MERGE_RANKINGS_ARGUMENT_COUNT);
static_assert(MERGE_ARGUMENT_COUNT - 1 == MERGE_SORTED_ARGUMENT_COUNT);

}

jsi::Value HybridNarsilCoreImpl::merge(jsi::Runtime& runtime, const jsi::Value* arguments, size_t count,
                                      bool scored) try {
  size_t skipped = scored ? 0 : 1;
  if (count != MERGE_ARGUMENT_COUNT - skipped || !arguments[MERGE_LIMIT - skipped].isNumber()) {
    return jsi::Value(-static_cast<double>(NARSIL_INVALID_ARGUMENT));
  }
  double limit = arguments[MERGE_LIMIT - skipped].getNumber();
  if (!std::isfinite(limit) || limit < 0 || limit > UINT32_MAX || std::floor(limit) != limit) {
    return jsi::Value(-static_cast<double>(NARSIL_INVALID_ARGUMENT));
  }
  TypedElements views(count);
  for (size_t argument = 0; argument < count; argument++) {
    if (argument != MERGE_LIMIT - skipped) views.prepare(runtime, argument, arguments[argument]);
  }
  auto offsets = views.read<const uint32_t>(runtime, MERGE_OFFSETS, "The list offsets");
  auto ranks = views.read<const uint32_t>(runtime, MERGE_RANKS - skipped, "The entry ranks");
  auto lists = views.read<uint32_t>(runtime, MERGE_LISTS - skipped, "The source list positions");
  auto indices = views.read<uint32_t>(runtime, MERGE_INDICES - skipped, "The within-list positions");
  narsil_merge_request request{};
  request.offsets = offsets.data;
  request.offset_count = offsets.length;
  request.ranks = ranks.data;
  request.rank_count = ranks.length;
  request.limit = static_cast<uint32_t>(limit);
  if (scored) {
    auto scores = views.read<const double>(runtime, MERGE_SCORES, "The entry scores");
    request.scores = scores.data;
    request.score_count = scores.length;
  }
  narsil_merge_output output{lists.data, lists.length, indices.data, indices.length, 0};
  RuntimeState& state = stateOf(runtime);
  if (state.keywordWorkspace == nullptr) {
    narsil_workspace* created = nullptr;
    if (narsil_workspace_create(&created) != NARSIL_OK) {
      return jsi::Value(-static_cast<double>(NARSIL_OUT_OF_MEMORY));
    }
    state.keywordWorkspace.reset(created);
  }
  narsil_status status = scored ? narsil_merge_rankings(state.keywordWorkspace.get(), &request, &output)
                                : narsil_merge_sorted(state.keywordWorkspace.get(), &request, &output);
  return jsi::Value(status == NARSIL_OK ? static_cast<double>(output.count) : -static_cast<double>(status));
} catch (const std::invalid_argument&) {
  return jsi::Value(-static_cast<double>(NARSIL_INVALID_ARGUMENT));
} catch (const std::length_error&) {
  return jsi::Value(-static_cast<double>(NARSIL_INVALID_ARGUMENT));
} catch (const std::bad_alloc&) {
  return jsi::Value(-static_cast<double>(NARSIL_OUT_OF_MEMORY));
}

jsi::Value HybridNarsilCoreImpl::mergeRankings(jsi::Runtime& runtime, const jsi::Value&,
                                              const jsi::Value* arguments, size_t count) {
  return merge(runtime, arguments, count, true);
}

jsi::Value HybridNarsilCoreImpl::mergeSorted(jsi::Runtime& runtime, const jsi::Value&,
                                            const jsi::Value* arguments, size_t count) {
  return merge(runtime, arguments, count, false);
}

}
