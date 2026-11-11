#include "HybridNarsilCoreImpl.hpp"
#include "TypedElements.hpp"
#include "narsil_group_merge.h"

#include <array>
#include <cmath>
#include <new>
#include <stdexcept>

namespace margelo::nitro::narsil {

namespace {

enum GroupArgument : size_t {
  KEYS, OFFSETS, SCORES, PRESENT, RANKS, ID_RANKS, SORTED, MAXIMUM, LIMIT,
  OUT_KEYS, OUT_OFFSETS, OUT_SOURCES, OUT_INDICES, ARGUMENT_COUNT
};

static_assert(ARGUMENT_COUNT == GROUP_MERGE_ARGUMENT_COUNT);
constexpr std::array<size_t, 8> REGION_ARGUMENTS{KEYS, OFFSETS, RANKS, ID_RANKS, OUT_KEYS, OUT_OFFSETS, OUT_SOURCES, OUT_INDICES};

bool unsignedArgument(const jsi::Value& value, uint32_t& into) {
  if (!value.isNumber()) return false;
  double number = value.getNumber();
  if (!std::isfinite(number) || number < 0 || number > UINT32_MAX || std::floor(number) != number) return false;
  into = static_cast<uint32_t>(number);
  return true;
}

}

jsi::Value HybridNarsilCoreImpl::mergeGroups(jsi::Runtime& runtime, const jsi::Value&,
                                            const jsi::Value* arguments, size_t count) try {
  narsil_group_merge_request request{};
  if (count != ARGUMENT_COUNT || !arguments[SORTED].isBool() ||
      !unsignedArgument(arguments[MAXIMUM], request.max_per_group)) {
    return jsi::Value(-static_cast<double>(NARSIL_INVALID_ARGUMENT));
  }
  request.sorted = arguments[SORTED].getBool() ? 1U : 0U;
  request.has_limit = arguments[LIMIT].isNull() ? 0U : 1U;
  request.has_scores = arguments[SCORES].isNull() ? 0U : 1U;
  request.has_score_present = arguments[PRESENT].isNull() ? 0U : 1U;
  if (request.has_limit != 0 && !unsignedArgument(arguments[LIMIT], request.limit)) {
    return jsi::Value(-static_cast<double>(NARSIL_INVALID_ARGUMENT));
  }
  TypedElements views(ARGUMENT_COUNT);
  for (size_t argument : REGION_ARGUMENTS) views.prepare(runtime, argument, arguments[argument]);
  if (request.has_scores != 0) views.prepare(runtime, SCORES, arguments[SCORES]);
  if (request.has_score_present != 0) views.prepare(runtime, PRESENT, arguments[PRESENT]);
  auto keys = views.read<const uint32_t>(runtime, KEYS, "The group identities");
  auto offsets = views.read<const uint32_t>(runtime, OFFSETS, "The group entry offsets");
  auto ranks = views.read<const uint32_t>(runtime, RANKS, "The entry ranks");
  auto idRanks = views.read<const uint32_t>(runtime, ID_RANKS, "The document ID ranks");
  auto outKeys = views.read<uint32_t>(runtime, OUT_KEYS, "The merged group identities");
  auto outOffsets = views.read<uint32_t>(runtime, OUT_OFFSETS, "The merged group offsets");
  auto outSources = views.read<uint32_t>(runtime, OUT_SOURCES, "The source group positions");
  auto outIndices = views.read<uint32_t>(runtime, OUT_INDICES, "The within-group positions");
  request.keys = keys.data;
  request.key_count = keys.length;
  request.offsets = offsets.data;
  request.offset_count = offsets.length;
  request.ranks = ranks.data;
  request.rank_count = ranks.length;
  request.id_ranks = idRanks.data;
  request.id_rank_count = idRanks.length;
  if (request.has_scores != 0) {
    auto scores = views.read<const double>(runtime, SCORES, "The raw entry scores");
    request.scores = scores.data;
    request.score_count = scores.length;
  }
  if (request.has_score_present != 0) {
    auto presence = views.read<const uint32_t>(runtime, PRESENT, "The score validity bitmap");
    request.score_present = presence.data;
    request.score_present_count = presence.length;
  }
  narsil_group_merge_output output{outKeys.data, outKeys.length, outOffsets.data, outOffsets.length,
                                    outSources.data, outSources.length, outIndices.data, outIndices.length, 0};
  RuntimeState& state = stateOf(runtime);
  if (state.keywordWorkspace == nullptr) {
    narsil_workspace* created = nullptr;
    if (narsil_workspace_create(&created) != NARSIL_OK) {
      return jsi::Value(-static_cast<double>(NARSIL_OUT_OF_MEMORY));
    }
    state.keywordWorkspace.reset(created);
  }
  narsil_status status = narsil_merge_groups(state.keywordWorkspace.get(), &request, &output);
  return jsi::Value(status == NARSIL_OK ? static_cast<double>(output.count) : -static_cast<double>(status));
} catch (const std::invalid_argument&) {
  return jsi::Value(-static_cast<double>(NARSIL_INVALID_ARGUMENT));
} catch (const std::length_error&) {
  return jsi::Value(-static_cast<double>(NARSIL_INVALID_ARGUMENT));
} catch (const std::bad_alloc&) {
  return jsi::Value(-static_cast<double>(NARSIL_OUT_OF_MEMORY));
}

}
