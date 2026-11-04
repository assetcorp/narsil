#include "HybridNarsilCoreImpl.hpp"
#include "AttachedField.hpp"
#include "GraphHeldAlone.hpp"
#include "HostMemory.hpp"

#include <atomic>
#include <cerrno>
#include <cmath>
#include <cstdint>
#include <memory>
#include <string>
#include <vector>

namespace margelo::nitro::narsil {

namespace {

constexpr uint32_t MEASURE_TOTALS_PAST_DIMENSION = 2;
constexpr uint32_t BACKGROUND_THREAD_SLOT_LIMIT = 64;
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

class BackgroundUse {
public:
  BackgroundUse(std::shared_ptr<HybridNarsilCoreImpl> core, std::shared_ptr<HybridNarsilAttachedStoreImpl> store,
                uint32_t threadSlot, narsil_workspace* workspace)
      : workspace(workspace), _core(std::move(core)), _store(std::move(store)), _threadSlot(threadSlot) {}
  ~BackgroundUse() { release(); }
  BackgroundUse(const BackgroundUse&) = delete;
  BackgroundUse& operator=(const BackgroundUse&) = delete;

  void release() {
    if (_released.exchange(true)) return;
    _store->endBackgroundUse();
    _core->releaseBackgroundSlot(_threadSlot);
  }

  narsil_workspace* const workspace;

private:
  std::shared_ptr<HybridNarsilCoreImpl> _core;
  std::shared_ptr<HybridNarsilAttachedStoreImpl> _store;
  uint32_t _threadSlot;
  std::atomic<bool> _released{false};
};

class ReleaseWhenDone {
public:
  explicit ReleaseWhenDone(std::shared_ptr<BackgroundUse> use) : _use(std::move(use)) {}
  ~ReleaseWhenDone() { _use->release(); }
  ReleaseWhenDone(const ReleaseWhenDone&) = delete;
  ReleaseWhenDone& operator=(const ReleaseWhenDone&) = delete;

private:
  std::shared_ptr<BackgroundUse> _use;
};

std::shared_ptr<BackgroundUse> startBackgroundUse(const std::shared_ptr<HybridNarsilCoreImpl>& core,
                                                  const std::shared_ptr<HybridNarsilAttachedStoreImpl>& store,
                                                  uint32_t threadSlot) {
  narsil_workspace* workspace = core->claimBackgroundSlot(threadSlot);
  if (!store->beginBackgroundUse()) {
    core->releaseBackgroundSlot(threadSlot);
    throwInvalid("The vector store is detached");
  }
  return std::make_shared<BackgroundUse>(core, store, threadSlot, workspace);
}

std::shared_ptr<std::vector<float>> copiedQuery(const MemoryView& query, uint32_t dimension) {
  size_t queryLength = 0;
  const float* values = elementsOf<float>(query, 1, "The query", &queryLength);
  if (queryLength != dimension) throwInvalid("The query has the wrong dimension");
  return std::make_shared<std::vector<float>>(values, values + queryLength);
}

std::shared_ptr<ArrayBuffer> allocatedFor(size_t count, size_t elementBytes) {
  return ArrayBuffer::allocate((count == 0 ? 1 : count) * elementBytes);
}

}

HybridNarsilCoreImpl::~HybridNarsilCoreImpl() {
  if (_workspace != nullptr) narsil_workspace_destroy(_workspace);
  for (auto& entry : _backgroundWorkspaces) narsil_workspace_destroy(entry.second);
}

narsil_workspace* HybridNarsilCoreImpl::claimBackgroundSlot(uint32_t threadSlot) {
  std::lock_guard<std::mutex> guard(_backgroundLock);
  if (_busyBackgroundSlots.count(threadSlot) != 0) throwInvalid("The thread slot is already searching");
  auto found = _backgroundWorkspaces.find(threadSlot);
  narsil_workspace* claimed = found == _backgroundWorkspaces.end() ? nullptr : found->second;
  if (claimed == nullptr) {
    if (narsil_workspace_create(&claimed) != NARSIL_OK) {
      throwSystemError(ENOMEM, "allocate a background search workspace", "");
    }
    _backgroundWorkspaces.emplace(threadSlot, claimed);
  }
  _busyBackgroundSlots.insert(threadSlot);
  return claimed;
}

void HybridNarsilCoreImpl::releaseBackgroundSlot(uint32_t threadSlot) {
  std::lock_guard<std::mutex> guard(_backgroundLock);
  _busyBackgroundSlots.erase(threadSlot);
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

std::shared_ptr<Promise<NativeSearchHits>> HybridNarsilCoreImpl::searchAsync(
    const std::shared_ptr<HybridNarsilAttachedGraphSpec>& graph,
    const std::shared_ptr<HybridNarsilAttachedStoreSpec>& store, const MemoryView& query, double metric,
    double candidateCount, double threadSlot, const MemoryView& accepted, bool filtered) {
  auto attachedGraph = attachedGraphOf(graph);
  auto attachedStore = attachedStoreOf(store);
  narsil_search_request request{};
  request.metric = unsignedOf(metric, "The metric");
  request.candidate_count = unsignedOf(candidateCount, "The candidate count");
  request.thread_slot = unsignedOf(threadSlot, "The thread slot");
  if (request.candidate_count == 0) throwInvalid("The candidate count must be at least 1");
  if (request.thread_slot >= attachedGraph->graph.thread_slots) throwInvalid("The thread slot is out of range");
  auto queryValues = copiedQuery(query, attachedStore->store.dimension);
  auto acceptedBits = std::make_shared<std::vector<uint8_t>>();
  if (filtered) {
    size_t acceptedBytes = 0;
    uint8_t* bits = elementsOf<uint8_t>(accepted, 0, "The accepted ordinals", &acceptedBytes);
    if (acceptedBytes > 0) acceptedBits->assign(bits, bits + acceptedBytes);
  }
  auto use = startBackgroundUse(shared_cast<HybridNarsilCoreImpl>(), attachedStore, request.thread_slot);
  return Promise<NativeSearchHits>::async([use, attachedGraph, attachedStore, request, queryValues, acceptedBits,
                                           filtered]() mutable {
    ReleaseWhenDone done(use);
    request.query = queryValues->data();
    if (filtered) {
      request.accepted.bits = acceptedBits->empty() ? &NO_ACCEPTED_ORDINAL : acceptedBits->data();
      request.accepted.bytes = clampedCount(acceptedBits->size());
    }
    size_t capacity = request.candidate_count;
    auto ordinals = allocatedFor(capacity, sizeof(int32_t));
    auto distances = allocatedFor(capacity, sizeof(double));
    narsil_candidates nearest{reinterpret_cast<int32_t*>(ordinals->data()),
                              reinterpret_cast<double*>(distances->data()), request.candidate_count, 0};
    narsil_status status =
        narsil_search(use->workspace, &attachedGraph->graph, &attachedStore->store, &request, &nearest);
    double count = status == NARSIL_OK ? static_cast<double>(nearest.count) : -statusOf(status);
    return NativeSearchHits(count, ordinals, distances);
  });
}

std::shared_ptr<Promise<NativeScores>> HybridNarsilCoreImpl::scoreAsync(
    const std::shared_ptr<HybridNarsilAttachedStoreSpec>& store, const MemoryView& query, double metric,
    const MemoryView& ordinals, double count, double threadSlot) {
  auto attachedStore = attachedStoreOf(store);
  narsil_score_request request{};
  request.metric = unsignedOf(metric, "The metric");
  request.count = unsignedOf(count, "The count");
  uint32_t slot = unsignedOf(threadSlot, "The thread slot");
  if (slot >= BACKGROUND_THREAD_SLOT_LIMIT) throwInvalid("The thread slot is out of range");
  auto queryValues = copiedQuery(query, attachedStore->store.dimension);
  const int32_t* chosen = elementsOf<int32_t>(ordinals, request.count, "The ordinals");
  auto chosenOrdinals = std::make_shared<std::vector<int32_t>>(chosen, chosen + request.count);
  auto use = startBackgroundUse(shared_cast<HybridNarsilCoreImpl>(), attachedStore, slot);
  return Promise<NativeScores>::async([use, attachedStore, request, queryValues, chosenOrdinals]() mutable {
    ReleaseWhenDone done(use);
    request.query = queryValues->data();
    request.ordinals = chosenOrdinals->data();
    auto distances = allocatedFor(request.count, sizeof(double));
    narsil_status status = narsil_score(use->workspace, &attachedStore->store, &request,
                                        reinterpret_cast<double*>(distances->data()));
    return NativeScores(statusOf(status), distances);
  });
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

std::shared_ptr<Promise<NativeConnectOutcome>> HybridNarsilCoreImpl::connectUnreachedAsync(
    const std::shared_ptr<HybridNarsilAttachedGraphSpec>& graph,
    const std::shared_ptr<HybridNarsilAttachedStoreSpec>& store, double metric, const MemoryView& nearby,
    double threadSlot) {
  auto attachedGraph = attachedGraphOf(graph);
  auto attachedStore = attachedStoreOf(store);
  narsil_connect_request request{};
  request.metric = unsignedOf(metric, "The metric");
  request.thread_slot = unsignedOf(threadSlot, "The thread slot");
  if (request.thread_slot >= attachedGraph->graph.thread_slots) throwInvalid("The thread slot is out of range");
  size_t nearbyCount = 0;
  const int32_t* chosen = elementsOf<int32_t>(nearby, 0, "The nearby ordinals", &nearbyCount);
  auto nearbyOrdinals = std::make_shared<std::vector<int32_t>>(chosen, chosen + nearbyCount);
  auto held = std::make_shared<GraphHeldAlone>(attachedGraph->graph.header);
  if (!held->held()) {
    return Promise<NativeConnectOutcome>::resolved(
        NativeConnectOutcome(statusOf(NARSIL_GRAPH_NOT_HELD_ALONE), allocatedFor(1, sizeof(int32_t))));
  }
  auto use = startBackgroundUse(shared_cast<HybridNarsilCoreImpl>(), attachedStore, request.thread_slot);
  narsil_graph walked = attachedGraph->graph;
  return Promise<NativeConnectOutcome>::async([use, held, attachedGraph, attachedStore, request, nearbyOrdinals,
                                               walked]() mutable {
    ReleaseWhenDone done(use);
    auto wakes = std::make_shared<PendingWakes>();
    walked.wake_context = wakes.get();
    request.nearby = nearbyOrdinals->empty() ? nullptr : nearbyOrdinals->data();
    request.nearby_count = clampedCount(nearbyOrdinals->size());
    narsil_status status = narsil_connect_unreached(use->workspace, &walked, &attachedStore->store, &request);
    if (status == NARSIL_OK) held->markEveryNodeLinked();
    held->release();
    auto list = allocatedFor(1 + static_cast<size_t>(wakes->count), sizeof(int32_t));
    auto* words = reinterpret_cast<int32_t*>(list->data());
    words[0] = static_cast<int32_t>(wakes->count);
    for (uint32_t i = 0; i < wakes->count; i++) words[1 + i] = wakes->ordinals[i];
    return NativeConnectOutcome(statusOf(status), list);
  });
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
