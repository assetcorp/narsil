#include "GraphHeldAlone.hpp"
#include "narsil_core.h"

namespace margelo::nitro::narsil {

namespace {

constexpr int32_t GRAPH_LOCK_FREE = 0;

}

GraphHeldAlone::GraphHeldAlone(int32_t* header) : _header(header), _held(false) {
  int32_t expected = GRAPH_LOCK_FREE;
  _held = __atomic_compare_exchange_n(_header + NARSIL_GRAPH_WORD_LOCK, &expected, NARSIL_GRAPH_HELD_ALONE, false,
                                      __ATOMIC_SEQ_CST, __ATOMIC_SEQ_CST);
}

GraphHeldAlone::~GraphHeldAlone() { release(); }

void GraphHeldAlone::markEveryNodeLinked() {
  if (_held && !_released.load()) __atomic_store_n(_header + NARSIL_GRAPH_WORD_UNLINKED_NODES, 0, __ATOMIC_SEQ_CST);
}

void GraphHeldAlone::release() {
  if (!_held || _released.exchange(true)) return;
  __atomic_store_n(_header + NARSIL_GRAPH_WORD_LOCK, GRAPH_LOCK_FREE, __ATOMIC_SEQ_CST);
}

}
