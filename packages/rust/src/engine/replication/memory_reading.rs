use super::PartitionCopies;

/// One reading of the process's memory, with whether the engine counts as full after it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct NodeMemoryReading {
    /// The resident memory of the process that no file backs, as the engine's write block reads it.
    pub process_bytes: u64,
    /// The memory that the process may use.
    pub process_limit_bytes: u64,
    /// Whether the engine refuses inserts and updates after this reading, under its block and resume fractions.
    pub full: bool,
}

/// Reads the process's memory and its limit as the engine's write block reads them, with `full` set to false, or
/// returns `None` on a system that reports no memory figures, for a process that holds no engine.
pub fn read_process_memory() -> Option<NodeMemoryReading> {
    let latest = crate::engine::memory::read_process_memory()?;
    Some(NodeMemoryReading {
        process_bytes: latest.process_bytes,
        process_limit_bytes: latest.limit_bytes,
        full: false,
    })
}

impl PartitionCopies<'_> {
    /// Measures the process's memory now, updates the engine's full state from that reading, and returns it, or
    /// returns `None` on a system that reports no memory figures.
    pub fn measure_memory(&self) -> Option<NodeMemoryReading> {
        let latest = self.engine.memory.measure_now()?;
        Some(NodeMemoryReading {
            process_bytes: latest.process_bytes,
            process_limit_bytes: latest.limit_bytes,
            full: self.engine.memory.is_full(),
        })
    }

    /// Returns the bytes that work in progress, such as a partition reload, holds in reserve against the engine's
    /// memory limit before it allocates them.
    pub fn reserved_memory_bytes(&self) -> u64 {
        self.engine.memory.reserved_bytes()
    }
}
