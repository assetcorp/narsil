#include "HybridNarsilCoreImpl.hpp"
#include "AttachedField.hpp"
#include "HostMemory.hpp"

#include <cerrno>
#include <cmath>
#include <cstdint>
#include <string>

namespace margelo::nitro::narsil {

namespace {

constexpr uint32_t MEASURE_TOTALS_PAST_DIMENSION = 2;
const uint8_t NO_ACCEPTED_ORDINAL = 0;

template <typename Element>
Element* elementsOf(const MemoryView& view, size_t minimum, const char* what, size_t* count = nullptr) {
  uint8_t* bytes = bytesWithin(view.buffer, view.byteOffset, view.byteLength, what);
  size_t elements = static_cast<size_t>(view.byteLength) / sizeof(Element);
  if ((bytes == nullptr && minimum > 0) || reinterpret_cast<uintptr_t>(bytes) % alignof(Element) != 0 ||
      static_cast<size_t>(view.byteLength) % sizeof(Element) != 0 || elements < minimum) {
    throwInvalid(std::string(what) + " has the wrong type, alignment, or length");
  }
  if (count != nullptr) *count = elements;
  return reinterpret_cast<Element*>(bytes);
}

uint32_t unsignedOf(double value, const char* what) {
  if (!std::isfinite(value) || value < 0 || value > UINT32_MAX || std::floor(value) != value) {
    throwInvalid(std::string(what) + " must be a whole number from 0 to 4294967295");
  }
  return static_cast<uint32_t>(value);
}

int32_t signedOf(double value, const char* what) {
  if (!std::isfinite(value) || value < INT32_MIN || value > INT32_MAX || std::floor(value) != value) {
    throwInvalid(std::string(what) + " must be a 32-bit whole number");
  }
  return static_cast<int32_t>(value);
}

uint32_t clampedCount(size_t count) { return count > UINT32_MAX ? UINT32_MAX : static_cast<uint32_t>(count); }

double statusOf(narsil_status status) { return static_cast<double>(status); }

}

HybridNarsilCoreImpl::~HybridNarsilCoreImpl() {
  if (_workspace != nullptr) narsil_workspace_destroy(_workspace);
}

narsil_workspace* HybridNarsilCoreImpl::workspace() {
  if (_workspace == nullptr && narsil_workspace_create(&_workspace) != NARSIL_OK) {
    _workspace = nullptr;
    throwSystemError(ENOMEM, "allocate the search workspace", "");
  }
  return _workspace;
}

double HybridNarsilCoreImpl::abiVersion() { return narsil_core_abi_version(); }

double HybridNarsilCoreImpl::workspaceBytes() { return static_cast<double>(narsil_workspace_bytes(workspace())); }

std::shared_ptr<HybridNarsilAttachedGraphSpec> HybridNarsilCoreImpl::attachGraph(const GraphMemory& memory) {
  return std::make_shared<HybridNarsilAttachedGraphImpl>(memory);
}

std::shared_ptr<HybridNarsilAttachedStoreSpec> HybridNarsilCoreImpl::attachStore(const StoreMemory& memory) {
  return std::make_shared<HybridNarsilAttachedStoreImpl>(memory);
}

double HybridNarsilCoreImpl::search(const std::shared_ptr<HybridNarsilAttachedGraphSpec>& graph,
                                    const std::shared_ptr<HybridNarsilAttachedStoreSpec>& store,
                                    const MemoryView& query, double metric, double candidateCount, double threadSlot,
                                    const MemoryView& ordinals, const MemoryView& distances,
                                    const MemoryView& accepted, bool filtered) {
  auto attachedGraph = attachedGraphOf(graph);
  auto attachedStore = attachedStoreOf(store);
  narsil_search_request request{};
  request.metric = unsignedOf(metric, "The metric");
  request.candidate_count = unsignedOf(candidateCount, "The candidate count");
  request.thread_slot = unsignedOf(threadSlot, "The thread slot");
  size_t queryLength = 0;
  request.query = elementsOf<float>(query, 1, "The query", &queryLength);
  if (queryLength != attachedStore->store.dimension) throwInvalid("The query has the wrong dimension");
  size_t ordinalCapacity = 0;
  size_t distanceCapacity = 0;
  int32_t* ordinalOut = elementsOf<int32_t>(ordinals, 1, "The ordinals", &ordinalCapacity);
  double* distanceOut = elementsOf<double>(distances, 1, "The distances", &distanceCapacity);
  uint32_t capacity = clampedCount(ordinalCapacity < distanceCapacity ? ordinalCapacity : distanceCapacity);
  if (capacity < request.candidate_count) throwInvalid("The result arrays hold fewer entries than the candidates");
  if (filtered) {
    size_t acceptedBytes = 0;
    uint8_t* bits = elementsOf<uint8_t>(accepted, 0, "The accepted ordinals", &acceptedBytes);
    request.accepted.bits = acceptedBytes == 0 ? &NO_ACCEPTED_ORDINAL : bits;
    request.accepted.bytes = clampedCount(acceptedBytes);
  }
  narsil_candidates nearest{ordinalOut, distanceOut, capacity, 0};
  narsil_status status = narsil_search(workspace(), &attachedGraph->graph, &attachedStore->store, &request, &nearest);
  if (status != NARSIL_OK) return -statusOf(status);
  return static_cast<double>(nearest.count);
}

double HybridNarsilCoreImpl::score(const std::shared_ptr<HybridNarsilAttachedStoreSpec>& store,
                                   const MemoryView& query, double metric, const MemoryView& ordinals, double count,
                                   const MemoryView& distances) {
  auto attachedStore = attachedStoreOf(store);
  narsil_score_request request{};
  request.metric = unsignedOf(metric, "The metric");
  request.count = unsignedOf(count, "The count");
  size_t queryLength = 0;
  request.query = elementsOf<float>(query, 1, "The query", &queryLength);
  if (queryLength != attachedStore->store.dimension) throwInvalid("The query has the wrong dimension");
  request.ordinals = elementsOf<int32_t>(ordinals, request.count, "The ordinals");
  double* out = elementsOf<double>(distances, request.count, "The distances");
  return statusOf(narsil_score(workspace(), &attachedStore->store, &request, out));
}

double HybridNarsilCoreImpl::place(const std::shared_ptr<HybridNarsilAttachedGraphSpec>& graph,
                                   const std::shared_ptr<HybridNarsilAttachedStoreSpec>& store, double metric,
                                   double ordinal, double topLayer, double graphHeldAlone, double threadSlot,
                                   const MemoryView& wakes) {
  auto attachedGraph = attachedGraphOf(graph);
  auto attachedStore = attachedStoreOf(store);
  narsil_place_request request{};
  request.metric = unsignedOf(metric, "The metric");
  request.ordinal = signedOf(ordinal, "The ordinal");
  request.top_layer = signedOf(topLayer, "The top layer");
  request.graph_held_alone = unsignedOf(graphHeldAlone, "The graph lock flag");
  request.thread_slot = unsignedOf(threadSlot, "The thread slot");
  attachedGraph->wakes.count = 0;
  narsil_status status = narsil_place(workspace(), &attachedGraph->graph, &attachedStore->store, &request);
  handOverWakes(attachedGraph->wakes, wakes);
  return statusOf(status);
}

double HybridNarsilCoreImpl::remove(const std::shared_ptr<HybridNarsilAttachedGraphSpec>& graph, double ordinal,
                                    double threadSlot, const MemoryView& wakes) {
  auto attachedGraph = attachedGraphOf(graph);
  narsil_remove_request request{};
  request.ordinal = signedOf(ordinal, "The ordinal");
  request.thread_slot = unsignedOf(threadSlot, "The thread slot");
  attachedGraph->wakes.count = 0;
  narsil_status status = narsil_remove(&attachedGraph->graph, &request);
  handOverWakes(attachedGraph->wakes, wakes);
  return statusOf(status);
}

double HybridNarsilCoreImpl::compact(const std::shared_ptr<HybridNarsilAttachedGraphSpec>& graph,
                                     const std::shared_ptr<HybridNarsilAttachedStoreSpec>& store, double metric,
                                     double threadSlot, const MemoryView& wakes) {
  auto attachedGraph = attachedGraphOf(graph);
  auto attachedStore = attachedStoreOf(store);
  narsil_compact_request request{};
  request.metric = unsignedOf(metric, "The metric");
  request.thread_slot = unsignedOf(threadSlot, "The thread slot");
  attachedGraph->wakes.count = 0;
  narsil_status status = narsil_compact(workspace(), &attachedGraph->graph, &attachedStore->store, &request);
  handOverWakes(attachedGraph->wakes, wakes);
  return statusOf(status);
}

double HybridNarsilCoreImpl::connectUnreached(const std::shared_ptr<HybridNarsilAttachedGraphSpec>& graph,
                                              const std::shared_ptr<HybridNarsilAttachedStoreSpec>& store,
                                              double metric, const MemoryView& nearby, double threadSlot,
                                              const MemoryView& wakes) {
  auto attachedGraph = attachedGraphOf(graph);
  auto attachedStore = attachedStoreOf(store);
  narsil_connect_request request{};
  request.metric = unsignedOf(metric, "The metric");
  request.thread_slot = unsignedOf(threadSlot, "The thread slot");
  size_t nearbyCount = 0;
  request.nearby = elementsOf<int32_t>(nearby, 0, "The nearby ordinals", &nearbyCount);
  request.nearby_count = clampedCount(nearbyCount);
  attachedGraph->wakes.count = 0;
  narsil_status status =
      narsil_connect_unreached(workspace(), &attachedGraph->graph, &attachedStore->store, &request);
  handOverWakes(attachedGraph->wakes, wakes);
  return statusOf(status);
}

double HybridNarsilCoreImpl::measure(const std::shared_ptr<HybridNarsilAttachedStoreSpec>& store, double metric,
                                     const MemoryView& ordinals, double count, const MemoryView& totals) {
  auto attachedStore = attachedStoreOf(store);
  narsil_ordinals_request request{};
  request.metric = unsignedOf(metric, "The metric");
  request.count = unsignedOf(count, "The count");
  request.ordinals = elementsOf<int32_t>(ordinals, request.count == 0 ? 1 : request.count, "The ordinals");
  size_t needed = static_cast<size_t>(attachedStore->store.dimension) + MEASURE_TOTALS_PAST_DIMENSION;
  double* out = elementsOf<double>(totals, needed, "The totals");
  return statusOf(narsil_measure(workspace(), &attachedStore->store, &request, out));
}

double HybridNarsilCoreImpl::quantise(const std::shared_ptr<HybridNarsilAttachedStoreSpec>& store, double metric,
                                      const MemoryView& ordinals, double count) {
  auto attachedStore = attachedStoreOf(store);
  narsil_ordinals_request request{};
  request.metric = unsignedOf(metric, "The metric");
  request.count = unsignedOf(count, "The count");
  request.ordinals = elementsOf<int32_t>(ordinals, request.count == 0 ? 1 : request.count, "The ordinals");
  return statusOf(narsil_quantise(workspace(), &attachedStore->store, &request));
}

}
