use super::ProcessMemory;
use super::constants::READ_PARSE_BLOCK_FRACTION;
use super::guard::MemoryGuard;
use crate::engine::Narsil;

/// The kind of request whose body a parse serves, which sets how much of the process memory limit the parse may
/// fill.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ParseKind {
    /// A body that writes or changes data, which may fill memory up to the level at which the engine blocks
    /// writes.
    Write,
    /// A body that only reads, which may fill memory up to 95 percent of the limit, or up to the write block
    /// level where that is higher.
    Read,
}

/// The memory figures behind a parse that [`Narsil::admit_parse`] refuses.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ParseShortfall {
    /// `true` where the parse needs more than its level of the limit even with no other memory in use, and
    /// `false` where only the memory in use leaves it no room.
    pub exceeds_limit: bool,
    /// The bytes that the parse can take.
    pub parse_bytes: u64,
    /// The process memory in use when the engine refused the parse.
    pub process_bytes: u64,
    /// The bytes that the writes in progress hold in reserve.
    pub reserved_bytes: u64,
    /// The level of the process memory limit that the parse may fill, in bytes.
    pub block_bytes: u64,
    /// `true` where the allocator handed free pages back to the system before the refusal.
    pub released_pages: bool,
}

fn line_of(guard: &MemoryGuard, kind: ParseKind) -> f64 {
    match kind {
        ParseKind::Write => guard.fractions.block,
        ParseKind::Read => guard.fractions.block.max(READ_PARSE_BLOCK_FRACTION),
    }
}

fn fits(guard: &MemoryGuard, figures: &ProcessMemory, line: f64, bytes: u64) -> bool {
    let room = line * figures.limit_bytes as f64
        - figures.process_bytes as f64
        - guard.reserved_bytes() as f64;
    bytes as f64 <= room
}

fn shortfall(
    guard: &MemoryGuard,
    figures: &ProcessMemory,
    line: f64,
    parse_bytes: u64,
    exceeds_limit: bool,
    released_pages: bool,
) -> ParseShortfall {
    ParseShortfall {
        exceeds_limit,
        parse_bytes,
        process_bytes: figures.process_bytes,
        reserved_bytes: guard.reserved_bytes(),
        block_bytes: (line * figures.limit_bytes as f64).floor() as u64,
        released_pages,
    }
}

impl Narsil {
    /// Admits the parse of a request body that can take up to `worst_bytes` of memory, and calls `scanned_bytes`
    /// for a closer figure only where the worst case leaves no room. The engine counts admitted bytes as memory
    /// in use until it next reads the process's memory.
    ///
    /// # Errors
    ///
    /// Returns the [`ParseShortfall`] where the parse would take process memory past the level of its limit that
    /// `kind` allows, after the allocator hands its free pages back. A system that reports no memory figures
    /// admits every parse.
    pub fn admit_parse(
        &self,
        worst_bytes: u64,
        scanned_bytes: impl FnOnce() -> u64,
        kind: ParseKind,
    ) -> std::result::Result<(), ParseShortfall> {
        let guard = &self.inner.memory;
        let line = line_of(guard, kind);
        let Some(recent) = guard.write_figures() else {
            return Ok(());
        };
        if fits(guard, &recent, line, worst_bytes) {
            guard.admit(worst_bytes);
            return Ok(());
        }
        let parse_bytes = scanned_bytes().min(worst_bytes);
        if parse_bytes as f64 > line * recent.limit_bytes as f64 {
            return Err(shortfall(guard, &recent, line, parse_bytes, true, false));
        }
        if fits(guard, &recent, line, parse_bytes) {
            guard.admit(parse_bytes);
            return Ok(());
        }
        let measured = guard.measure_now().unwrap_or(recent);
        if fits(guard, &measured, line, parse_bytes) {
            guard.admit(parse_bytes);
            return Ok(());
        }
        let releases = guard.releases();
        let settled = guard.measure_after_release().unwrap_or(measured);
        let released_pages = guard.releases() != releases;
        if fits(guard, &settled, line, parse_bytes) {
            guard.admit(parse_bytes);
            return Ok(());
        }
        if released_pages && kind == ParseKind::Write {
            guard.refused_after_release(&settled);
        }
        Err(shortfall(
            guard,
            &settled,
            line,
            parse_bytes,
            false,
            released_pages,
        ))
    }
}
