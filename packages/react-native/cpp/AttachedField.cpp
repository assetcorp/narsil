#include "AttachedField.hpp"
#include "HostMemory.hpp"

#include <cmath>
#include <string>

namespace margelo::nitro::narsil {

namespace {

struct Region {
  uint8_t* bytes;
  size_t elements;
};

Region heldRegion(const MemoryView& view, size_t elementBytes, std::vector<std::shared_ptr<ArrayBuffer>>& held,
                  const char* what) {
  if (!isHostOwned(view.buffer)) {
    throwInvalid(std::string(what) + " lies outside the memory that this module allocated");
  }
  uint8_t* bytes = bytesWithin(view.buffer, view.byteOffset, view.byteLength, what);
  if (bytes == nullptr || reinterpret_cast<uintptr_t>(bytes) % elementBytes != 0 ||
      static_cast<size_t>(view.byteLength) % elementBytes != 0) {
    throwInvalid(std::string(what) + " is empty or misaligned");
  }
  held.push_back(view.buffer);
  return Region{bytes, static_cast<size_t>(view.byteLength) / elementBytes};
}

uint32_t wholeCount(double value, const char* what) {
  if (!std::isfinite(value) || value < 0 || value > UINT32_MAX || std::floor(value) != value) {
    throwInvalid(std::string(what) + " must be a whole number from 0 to 4294967295");
  }
  return static_cast<uint32_t>(value);
}

int32_t headerWord(const int32_t* words, uint32_t index) { return __atomic_load_n(words + index, __ATOMIC_SEQ_CST); }

bool covers(size_t length, uint64_t required) { return static_cast<uint64_t>(length) >= required; }

void rememberWake(void* context, int32_t ordinal) {
  auto* wakes = static_cast<PendingWakes*>(context);
  if (wakes->count >= WAKES_KEPT_PER_CALL) return;
  wakes->ordinals[wakes->count] = ordinal;
  wakes->count += 1;
}

uint64_t bytesInUse(uint64_t slots, uint64_t entriesPerBlock, uint64_t entryBytes, uint32_t index) {
  uint64_t first = static_cast<uint64_t>(index) * entriesPerBlock;
  if (first >= slots) return 0;
  uint64_t remaining = slots - first;
  return (remaining < entriesPerBlock ? remaining : entriesPerBlock) * entryBytes;
}

template <typename Pointer>
void readBlocks(const std::vector<MemoryView>& views, uint64_t slots, uint64_t entriesPerBlock, uint64_t entryBytes,
                size_t alignment, std::vector<std::shared_ptr<ArrayBuffer>>& held, std::vector<Pointer>& out,
                const char* what) {
  out.assign(views.size(), nullptr);
  for (size_t index = 0; index < views.size(); index++) {
    const MemoryView& view = views[index];
    if (view.byteLength == 0) continue;
    Region region = heldRegion(view, 1, held, what);
    if (reinterpret_cast<uintptr_t>(region.bytes) % alignment != 0 ||
        !covers(region.elements, bytesInUse(slots, entriesPerBlock, entryBytes, static_cast<uint32_t>(index)))) {
      throwInvalid(std::string(what) + " is misaligned or smaller than the records it holds");
    }
    out[index] = reinterpret_cast<Pointer>(region.bytes);
  }
}

}

HybridNarsilAttachedGraphImpl::HybridNarsilAttachedGraphImpl(const GraphMemory& memory) : HybridObject(TAG) {
  Region header = heldRegion(memory.graphHeader, sizeof(int32_t), _held, "The graph header");
  if (header.elements < NARSIL_GRAPH_HEADER_WORDS) throwInvalid("The graph header is too short");
  Region levels = heldRegion(memory.nodeLevels, 1, _held, "The node levels");
  Region level0 = heldRegion(memory.level0, sizeof(int32_t), _held, "The base layer");
  Region upperBase = heldRegion(memory.upperBase, sizeof(int32_t), _held, "The upper layer starts");
  Region upper = heldRegion(memory.upper, sizeof(int32_t), _held, "The upper layers");
  Region locks = heldRegion(memory.locks, sizeof(int32_t), _held, "The node locks");
  Region tombstones = heldRegion(memory.tombstones, 1, _held, "The tombstones");
  Region incoming = heldRegion(memory.incoming, sizeof(int32_t), _held, "The incoming counts");
  Region due = heldRegion(memory.nearestLinkDue, 1, _held, "The nearest link flags");
  Region heldLocks = heldRegion(memory.heldLocks, sizeof(int32_t), _held, "The held locks");
  graph.header = reinterpret_cast<int32_t*>(header.bytes);
  graph.node_levels = levels.bytes;
  graph.level0 = reinterpret_cast<int32_t*>(level0.bytes);
  graph.upper_base = reinterpret_cast<int32_t*>(upperBase.bytes);
  graph.upper = reinterpret_cast<int32_t*>(upper.bytes);
  graph.locks = reinterpret_cast<int32_t*>(locks.bytes);
  graph.tombstones = tombstones.bytes;
  graph.incoming = reinterpret_cast<int32_t*>(incoming.bytes);
  graph.nearest_link_due = due.bytes;
  graph.held_locks = reinterpret_cast<int32_t*>(heldLocks.bytes);
  size_t threadSlots = heldLocks.elements / NARSIL_HELD_WORDS_PER_THREAD;
  graph.thread_slots = threadSlots > UINT32_MAX ? UINT32_MAX : static_cast<uint32_t>(threadSlots);
  if (graph.thread_slots == 0) throwInvalid("The held locks hold no thread slot");
  int32_t slots = headerWord(graph.header, NARSIL_GRAPH_WORD_SLOTS);
  int32_t upperUsed = headerWord(graph.header, NARSIL_GRAPH_WORD_UPPER_USED);
  int32_t maxBaseNeighbours = headerWord(graph.header, NARSIL_GRAPH_WORD_MMAX0);
  if (slots < 0 || upperUsed < 0 || maxBaseNeighbours <= 0) throwInvalid("The graph header is inconsistent");
  uint64_t ordinals = static_cast<uint64_t>(slots);
  uint64_t baseStride = static_cast<uint64_t>(maxBaseNeighbours) + NARSIL_LIST_WORDS_OVER_NEIGHBOURS;
  if (!covers(levels.elements, ordinals) || !covers(level0.elements, ordinals * baseStride) ||
      !covers(upperBase.elements, ordinals) || !covers(locks.elements, ordinals) ||
      !covers(tombstones.elements, ordinals) || !covers(incoming.elements, ordinals) ||
      !covers(due.elements, ordinals) || !covers(upper.elements, static_cast<uint64_t>(upperUsed))) {
    throwInvalid("The graph regions are smaller than the graph they hold");
  }
  graph.wake = rememberWake;
  graph.wake_context = &wakes;
}

HybridNarsilAttachedStoreImpl::HybridNarsilAttachedStoreImpl(const StoreMemory& memory) : HybridObject(TAG) {
  store.dimension = wholeCount(memory.dimension, "The dimension");
  store.bits = wholeCount(memory.bits, "The code bits");
  store.records_per_block = wholeCount(memory.recordsPerBlock, "The records per block");
  store.vectors_per_block = wholeCount(memory.vectorsPerBlock, "The vectors per block");
  uint32_t strideBytes = wholeCount(memory.vectorStrideBytes, "The vector stride");
  if (store.dimension == 0 || strideBytes % sizeof(float) != 0) throwInvalid("The vector layout is invalid");
  store.vector_stride_floats = strideBytes / sizeof(float);
  if (store.vector_stride_floats < store.dimension) throwInvalid("The vector stride is shorter than a vector");
  Region header = heldRegion(memory.storeHeader, sizeof(int32_t), _held, "The store header");
  if (header.elements < NARSIL_STORE_HEADER_WORDS) throwInvalid("The store header is too short");
  store.header = reinterpret_cast<int32_t*>(header.bytes);
  Region codePresent = heldRegion(memory.codePresent, 1, _held, "The code flags");
  Region centroid = heldRegion(memory.centroid, sizeof(float), _held, "The centroid");
  if (centroid.elements < store.dimension) throwInvalid("The centroid is shorter than a vector");
  Region magnitudes = heldRegion(memory.magnitudes, sizeof(double), _held, "The magnitudes");
  Region present = heldRegion(memory.present, 1, _held, "The presence flags");
  Region vectorFile = heldRegion(memory.vectorFile, sizeof(int32_t), _held, "The vector file table");
  Region vectorOffset = heldRegion(memory.vectorOffset, sizeof(uint32_t), _held, "The vector offsets");
  Region bornAt = heldRegion(memory.bornAt, sizeof(int64_t), _held, "The born sequences");
  Region retiredAt = heldRegion(memory.retiredAt, sizeof(int64_t), _held, "The retired sequences");
  Region pins = heldRegion(memory.pins, sizeof(int64_t), _held, "The pins");
  if (pins.elements == 0 || pins.elements > UINT32_MAX) throwInvalid("The pins hold no thread slot");
  store.born_at = reinterpret_cast<const int64_t*>(bornAt.bytes);
  store.retired_at = reinterpret_cast<const int64_t*>(retiredAt.bytes);
  store.pins = reinterpret_cast<const int64_t*>(pins.bytes);
  store.pin_slots = static_cast<uint32_t>(pins.elements);
  store.code_present = codePresent.bytes;
  store.centroid = reinterpret_cast<float*>(centroid.bytes);
  store.magnitudes = reinterpret_cast<const double*>(magnitudes.bytes);
  store.present = present.bytes;
  store.vector_file = reinterpret_cast<const int32_t*>(vectorFile.bytes);
  store.vector_offset = reinterpret_cast<const uint32_t*>(vectorOffset.bytes);
  int32_t storedSlots = headerWord(store.header, NARSIL_STORE_WORD_SLOTS);
  if (storedSlots < 0) throwInvalid("The store header is inconsistent");
  uint64_t slots = static_cast<uint64_t>(storedSlots);
  if (!covers(codePresent.elements, slots) || !covers(magnitudes.elements, slots) || !covers(present.elements, slots) ||
      !covers(vectorFile.elements, slots) || !covers(vectorOffset.elements, slots) || !covers(bornAt.elements, slots) ||
      !covers(retiredAt.elements, slots)) {
    throwInvalid("The store regions are smaller than the vectors they hold");
  }
  readBlocks(memory.codeBlocks, slots, store.records_per_block, narsil_record_bytes(store.dimension, store.bits), 1,
             _held, _codeBlocks, "A code block");
  readBlocks(memory.vectorBlocks, slots, store.vectors_per_block, strideBytes, alignof(float), _held, _vectorBlocks,
             "A vector block");
  store.code_blocks = _codeBlocks.data();
  store.code_block_count = static_cast<uint32_t>(_codeBlocks.size());
  store.vector_blocks = _vectorBlocks.data();
  store.vector_block_count = static_cast<uint32_t>(_vectorBlocks.size());
  _files.assign(memory.vectorFiles.size(), narsil_vector_file{nullptr, 0, nullptr});
  for (size_t index = 0; index < memory.vectorFiles.size(); index++) {
    const std::string& path = memory.vectorFiles[index];
    if (path.empty()) continue;
    if (narsil_vector_file_map(path.c_str(), &_files[index]) != NARSIL_OK) {
      unmapFiles();
      throwInvalid("The vector file " + path + " cannot be mapped");
    }
  }
  store.files = _files.data();
  store.file_count = static_cast<uint32_t>(_files.size());
}

HybridNarsilAttachedStoreImpl::~HybridNarsilAttachedStoreImpl() { unmapFiles(); }

void HybridNarsilAttachedStoreImpl::unmapFiles() {
  for (narsil_vector_file& file : _files) narsil_vector_file_unmap(&file);
  _files.clear();
  store.files = nullptr;
  store.file_count = 0;
}

double HybridNarsilAttachedStoreImpl::detach() {
  std::lock_guard<std::mutex> guard(_useLock);
  _detached = true;
  if (_backgroundUses > 0) {
    _unmapAfterUse = true;
    return 0;
  }
  unmapFiles();
  return 0;
}

bool HybridNarsilAttachedStoreImpl::beginBackgroundUse() {
  std::lock_guard<std::mutex> guard(_useLock);
  if (_detached) return false;
  _backgroundUses += 1;
  return true;
}

void HybridNarsilAttachedStoreImpl::endBackgroundUse() {
  std::lock_guard<std::mutex> guard(_useLock);
  _backgroundUses -= 1;
  if (_backgroundUses == 0 && _unmapAfterUse) {
    _unmapAfterUse = false;
    unmapFiles();
  }
}

std::shared_ptr<HybridNarsilAttachedGraphImpl> attachedGraphOf(
    const std::shared_ptr<HybridNarsilAttachedGraphSpec>& graph) {
  auto attached = std::dynamic_pointer_cast<HybridNarsilAttachedGraphImpl>(graph);
  if (attached == nullptr) throwInvalid("The call takes a graph that this core attached");
  return attached;
}

std::shared_ptr<HybridNarsilAttachedStoreImpl> attachedStoreOf(
    const std::shared_ptr<HybridNarsilAttachedStoreSpec>& store) {
  auto attached = std::dynamic_pointer_cast<HybridNarsilAttachedStoreImpl>(store);
  if (attached == nullptr || attached->isDetached()) throwInvalid("The call takes a store that this core attached");
  return attached;
}

uint32_t handOverWakes(PendingWakes& wakes, const MemoryView& target) {
  uint8_t* bytes = bytesWithin(target.buffer, target.byteOffset, target.byteLength, "The wake list");
  size_t capacity = static_cast<size_t>(target.byteLength) / sizeof(int32_t);
  if (bytes == nullptr || capacity < 1 || reinterpret_cast<uintptr_t>(bytes) % sizeof(int32_t) != 0) {
    wakes.count = 0;
    throwInvalid("The wake list must be an aligned Int32Array with room for its count");
  }
  auto* out = reinterpret_cast<int32_t*>(bytes);
  uint32_t kept = wakes.count;
  if (kept > capacity - 1) kept = static_cast<uint32_t>(capacity - 1);
  for (uint32_t index = 0; index < kept; index++) out[index + 1] = wakes.ordinals[index];
  out[0] = static_cast<int32_t>(kept);
  wakes.count = 0;
  return kept;
}

}
