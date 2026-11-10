use std::fs::File;
use std::io;
use std::path::Path;
use std::sync::OnceLock;
use std::time::{SystemTime, UNIX_EPOCH};

#[cfg(target_os = "linux")]
const ENOTSUP: i32 = 95;
#[cfg(all(unix, not(target_os = "linux")))]
const ENOTSUP: i32 = 45;
#[cfg(unix)]
const EPERM: i32 = 1;
#[cfg(unix)]
const EISDIR: i32 = 21;
#[cfg(unix)]
const EINVAL: i32 = 22;
#[cfg(all(unix, not(target_os = "linux")))]
const ESRCH: i32 = 3;
#[cfg(target_vendor = "apple")]
const ENOTTY: i32 = 25;

#[cfg(unix)]
unsafe extern "C" {
    #[cfg(target_vendor = "apple")]
    fn fsync(descriptor: i32) -> i32;
    fn kill(pid: i32, signal: i32) -> i32;
    #[cfg(target_os = "linux")]
    fn sysconf(name: i32) -> core::ffi::c_long;
}

#[cfg(target_os = "linux")]
const SYSCONF_CLOCK_TICKS: i32 = 2;

#[cfg(windows)]
unsafe extern "system" {
    fn OpenProcess(access: u32, inherit: i32, pid: u32) -> *mut core::ffi::c_void;
    fn GetExitCodeProcess(process: *mut core::ffi::c_void, code: *mut u32) -> i32;
    fn CloseHandle(handle: *mut core::ffi::c_void) -> i32;
    fn GetLastError() -> u32;
}

#[cfg(windows)]
const PROCESS_QUERY_LIMITED_INFORMATION: u32 = 0x1000;
#[cfg(windows)]
const STILL_ACTIVE: u32 = 259;
#[cfg(windows)]
const ERROR_ACCESS_DENIED: u32 = 5;

#[cfg(target_vendor = "apple")]
fn full_sync_unsupported(error: &io::Error) -> bool {
    matches!(error.raw_os_error(), Some(code) if code == ENOTSUP || code == EINVAL || code == ENOTTY)
}

pub(crate) fn sync_file(file: &File) -> io::Result<()> {
    #[cfg(target_vendor = "apple")]
    {
        match file.sync_all() {
            Err(error) if full_sync_unsupported(&error) => plain_fsync(file),
            other => other,
        }
    }
    #[cfg(not(target_vendor = "apple"))]
    {
        file.sync_all()
    }
}

#[cfg(target_vendor = "apple")]
fn plain_fsync(file: &File) -> io::Result<()> {
    use std::os::fd::AsRawFd;
    let status = unsafe { fsync(file.as_raw_fd()) };
    if status == 0 {
        Ok(())
    } else {
        Err(io::Error::last_os_error())
    }
}

#[cfg(unix)]
fn directory_sync_unsupported(error: &io::Error) -> bool {
    matches!(error.raw_os_error(), Some(code) if code == EISDIR || code == EPERM || code == EINVAL || code == ENOTSUP)
}

#[cfg(unix)]
pub(crate) fn sync_directory(path: &Path) -> io::Result<()> {
    match File::open(path).and_then(|directory| sync_file(&directory)) {
        Err(error) if directory_sync_unsupported(&error) => Ok(()),
        other => other,
    }
}

#[cfg(windows)]
pub(crate) fn sync_directory(_path: &Path) -> io::Result<()> {
    Ok(())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub(crate) struct DirectoryIdentity {
    device: u64,
    node: u64,
}

#[cfg(unix)]
pub(crate) fn directory_identity(path: &Path) -> io::Result<DirectoryIdentity> {
    use std::os::unix::fs::MetadataExt;
    let metadata = std::fs::metadata(path)?;
    Ok(DirectoryIdentity {
        device: metadata.dev(),
        node: metadata.ino(),
    })
}

#[cfg(windows)]
pub(crate) fn directory_identity(path: &Path) -> io::Result<DirectoryIdentity> {
    use std::hash::{DefaultHasher, Hash, Hasher};
    use std::os::windows::fs::MetadataExt;
    let canonical = std::fs::canonicalize(path)?;
    let metadata = std::fs::metadata(&canonical)?;
    let mut hasher = DefaultHasher::new();
    canonical.to_string_lossy().to_lowercase().hash(&mut hasher);
    Ok(DirectoryIdentity {
        device: hasher.finish(),
        node: metadata.creation_time(),
    })
}

pub(crate) fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as u64)
        .unwrap_or(0)
}

pub(crate) fn current_thread_number() -> Option<u64> {
    let described = format!("{:?}", std::thread::current().id());
    let digits: String = described.chars().filter(char::is_ascii_digit).collect();
    digits.parse().ok()
}

pub(crate) fn current_process_start_ms() -> Option<u64> {
    static FIRST_SEEN_MS: OnceLock<u64> = OnceLock::new();
    #[cfg(target_os = "linux")]
    if let ProcessState::Running(Some(start)) = process_state(std::process::id()) {
        return Some(start);
    }
    Some(*FIRST_SEEN_MS.get_or_init(now_ms))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ProcessState {
    Exited,
    Running(Option<u64>),
    Unknown,
}

#[cfg(target_os = "linux")]
fn linux_start_ms(stat: &str) -> Option<(char, u64)> {
    let after = &stat[stat.rfind(')')? + 1..];
    let fields: Vec<&str> = after.split_whitespace().collect();
    let state = fields.first()?.chars().next()?;
    let start_ticks: f64 = fields.get(19)?.parse().ok()?;
    let ticks = unsafe { sysconf(SYSCONF_CLOCK_TICKS) };
    if ticks <= 0 {
        return None;
    }
    let uptime: f64 = std::fs::read_to_string("/proc/uptime")
        .ok()?
        .split_whitespace()
        .next()?
        .parse()
        .ok()?;
    let started_ago_ms = (uptime - start_ticks / ticks as f64) * 1000.0;
    let start = now_ms() as f64 - started_ago_ms;
    if !start.is_finite() || start < 0.0 {
        return None;
    }
    Some((state, start.round() as u64))
}

#[cfg(target_os = "linux")]
pub(crate) fn process_state(pid: u32) -> ProcessState {
    let status = match std::fs::read_to_string(format!("/proc/{pid}/status")) {
        Ok(status) => status,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return ProcessState::Exited,
        Err(_) => return ProcessState::Unknown,
    };
    let leader = status
        .lines()
        .find_map(|line| line.strip_prefix("Tgid:"))
        .and_then(|value| value.trim().parse::<u32>().ok());
    match leader {
        None => return ProcessState::Unknown,
        Some(leader) if leader != pid => return ProcessState::Exited,
        Some(_) => {}
    }
    let Ok(stat) = std::fs::read_to_string(format!("/proc/{pid}/stat")) else {
        return ProcessState::Unknown;
    };
    match linux_start_ms(&stat) {
        Some(('Z' | 'X' | 'x', _)) => ProcessState::Exited,
        Some((_, start)) => ProcessState::Running(Some(start)),
        None => ProcessState::Unknown,
    }
}

#[cfg(all(unix, not(target_os = "linux")))]
pub(crate) fn process_state(pid: u32) -> ProcessState {
    let Ok(signed) = i32::try_from(pid) else {
        return ProcessState::Unknown;
    };
    if signed <= 0 {
        return ProcessState::Unknown;
    }
    if unsafe { kill(signed, 0) } == 0 {
        return ProcessState::Running(None);
    }
    match io::Error::last_os_error().raw_os_error() {
        Some(code) if code == EPERM => ProcessState::Running(None),
        Some(code) if code == ESRCH => ProcessState::Exited,
        _ => ProcessState::Unknown,
    }
}

#[cfg(target_os = "linux")]
pub(crate) fn signal_reaches(pid: u32) -> bool {
    let Ok(signed) = i32::try_from(pid) else {
        return false;
    };
    if signed <= 0 {
        return false;
    }
    unsafe { kill(signed, 0) == 0 || io::Error::last_os_error().raw_os_error() == Some(EPERM) }
}

#[cfg(all(unix, not(target_os = "linux")))]
pub(crate) fn signal_reaches(pid: u32) -> bool {
    matches!(process_state(pid), ProcessState::Running(_))
}

#[cfg(windows)]
pub(crate) fn process_state(pid: u32) -> ProcessState {
    let handle = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
    if handle.is_null() {
        return if unsafe { GetLastError() } == ERROR_ACCESS_DENIED {
            ProcessState::Running(None)
        } else {
            ProcessState::Exited
        };
    }
    let mut code: u32 = 0;
    let read = unsafe { GetExitCodeProcess(handle, &mut code) };
    unsafe { CloseHandle(handle) };
    if read == 0 {
        ProcessState::Unknown
    } else if code == STILL_ACTIVE {
        ProcessState::Running(None)
    } else {
        ProcessState::Exited
    }
}

#[cfg(windows)]
pub(crate) fn signal_reaches(pid: u32) -> bool {
    matches!(process_state(pid), ProcessState::Running(_))
}

#[cfg(target_os = "linux")]
pub(crate) fn process_holds_file_in(pid: u32, directory: &Path) -> bool {
    let Ok(directory) = std::fs::canonicalize(directory) else {
        return false;
    };
    let Ok(entries) = std::fs::read_dir(format!("/proc/{pid}/fd")) else {
        return false;
    };
    entries.flatten().any(|entry| {
        std::fs::read_link(entry.path())
            .is_ok_and(|target| target == directory || target.starts_with(&directory))
    })
}

#[cfg(not(target_os = "linux"))]
pub(crate) fn process_holds_file_in(_pid: u32, _directory: &Path) -> bool {
    false
}

#[cfg(target_os = "linux")]
pub(crate) fn hold_directory_open(path: &Path) -> Option<File> {
    File::open(path).ok()
}

#[cfg(not(target_os = "linux"))]
pub(crate) fn hold_directory_open(_path: &Path) -> Option<File> {
    None
}

pub(crate) fn random_token() -> io::Result<String> {
    let mut bytes = [0u8; 16];
    getrandom::fill(&mut bytes).map_err(|error| io::Error::other(error.to_string()))?;
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}

#[cfg(windows)]
fn retried_while_access_is_denied(mut operation: impl FnMut() -> io::Result<()>) -> io::Result<()> {
    use super::constants::{WINDOWS_RENAME_ATTEMPTS, WINDOWS_RENAME_RETRY_MS};
    let mut attempt = 0;
    loop {
        match operation() {
            Err(error)
                if error.kind() == io::ErrorKind::PermissionDenied
                    && attempt + 1 < WINDOWS_RENAME_ATTEMPTS =>
            {
                attempt += 1;
                std::thread::sleep(std::time::Duration::from_millis(WINDOWS_RENAME_RETRY_MS));
            }
            other => return other,
        }
    }
}

#[cfg(not(windows))]
fn retried_while_access_is_denied(mut operation: impl FnMut() -> io::Result<()>) -> io::Result<()> {
    operation()
}

pub(crate) fn rename_replacing(from: &Path, to: &Path) -> io::Result<()> {
    retried_while_access_is_denied(|| std::fs::rename(from, to))
}

pub(crate) fn remove_file(path: &Path) -> io::Result<()> {
    retried_while_access_is_denied(|| std::fs::remove_file(path))
}
