use super::constants::KIBIBYTE_BYTES;

const PROCESS_STATUS_PATH: &str = "/proc/self/status";
const PROCESS_CGROUP_PATH: &str = "/proc/self/cgroup";
const MEMORY_INFO_PATH: &str = "/proc/meminfo";
const CGROUP_ROOT: &str = "/sys/fs/cgroup";
const CGROUP_V1_MEMORY_ROOT: &str = "/sys/fs/cgroup/memory";
const RESIDENT_SET_FIELD: &str = "VmRSS:";
const TOTAL_MEMORY_FIELD: &str = "MemTotal:";
const AVAILABLE_MEMORY_FIELD: &str = "MemAvailable:";
const CGROUP_V2_LIMIT_FILES: [&str; 2] = ["memory.max", "memory.high"];
const CGROUP_V1_LIMIT_FILE: &str = "memory.limit_in_bytes";

fn kibibyte_field(text: &str, field: &str) -> Option<u64> {
    let line = text.lines().find_map(|line| line.strip_prefix(field))?;
    let kibibytes: u64 = line.trim().strip_suffix("kB")?.trim().parse().ok()?;
    kibibytes.checked_mul(KIBIBYTE_BYTES)
}

/// Returns the resident set size of this process.
pub(super) fn resident_bytes() -> Option<u64> {
    let status = std::fs::read_to_string(PROCESS_STATUS_PATH).ok()?;
    kibibyte_field(&status, RESIDENT_SET_FIELD)
}

fn limit_in(path: &std::path::Path) -> Option<u64> {
    let text = std::fs::read_to_string(path).ok()?;
    text.trim().parse::<u64>().ok().filter(|bytes| *bytes > 0)
}

fn smallest(limits: impl Iterator<Item = Option<u64>>) -> Option<u64> {
    limits.flatten().min()
}

/// Returns the smallest memory limit of this process's cgroup and of each cgroup above it, under cgroup v2 or
/// the memory controller of cgroup v1, where any is set.
fn cgroup_limit_bytes() -> Option<u64> {
    let membership = std::fs::read_to_string(PROCESS_CGROUP_PATH).ok()?;
    let mut found = None;
    for line in membership.lines() {
        let mut parts = line.splitn(3, ':');
        let (Some(_), Some(controllers), Some(path)) = (parts.next(), parts.next(), parts.next())
        else {
            continue;
        };
        let (root, files): (&str, &[&str]) = if controllers.is_empty() {
            (CGROUP_ROOT, &CGROUP_V2_LIMIT_FILES)
        } else if controllers
            .split(',')
            .any(|controller| controller == "memory")
        {
            (
                CGROUP_V1_MEMORY_ROOT,
                std::slice::from_ref(&CGROUP_V1_LIMIT_FILE),
            )
        } else {
            continue;
        };
        let root = std::path::Path::new(root);
        let mut directory = root.join(path.trim_start_matches('/'));
        loop {
            let here = smallest(files.iter().map(|file| limit_in(&directory.join(file))));
            found = smallest([found, here].into_iter());
            if directory == root || !directory.pop() {
                break;
            }
        }
    }
    found
}

/// Returns the memory that this process may use: its cgroup's limit where one lies below the machine's memory,
/// and otherwise the smaller of the machine's memory and the resident memory plus the memory available, which is
/// how Node.js measures the same limit.
pub(super) fn limit_bytes(resident: u64) -> Option<u64> {
    let info = std::fs::read_to_string(MEMORY_INFO_PATH).ok()?;
    let host = kibibyte_field(&info, TOTAL_MEMORY_FIELD)?;
    if let Some(constrained) = cgroup_limit_bytes()
        && constrained < host
    {
        return Some(constrained);
    }
    match kibibyte_field(&info, AVAILABLE_MEMORY_FIELD) {
        Some(available) => Some(host.min(resident.saturating_add(available))),
        None => Some(host),
    }
}

#[cfg(target_env = "gnu")]
unsafe extern "C" {
    fn malloc_trim(pad: usize) -> i32;
}

/// Returns the allocator's free pages to the system, and reports whether any went back.
#[cfg(target_env = "gnu")]
pub(super) fn release_free_pages() -> bool {
    unsafe { malloc_trim(0) == 1 }
}

#[cfg(not(target_env = "gnu"))]
pub(super) fn release_free_pages() -> bool {
    false
}
