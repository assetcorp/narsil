use std::collections::HashSet;
use std::fs::{File, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use crate::error::{ErrorCode, NarsilError, Result};

use super::constants::{
    DIRECTORY_LOCK_ATTEMPTS, DIRECTORY_LOCK_PROCESS_START_TOLERANCE_MS, DIRECTORY_LOCK_SETTLE_MS,
    MAX_LOCK_FILE_BYTES,
};
use super::platform::{
    DirectoryIdentity, ProcessState, current_process_start_ms, current_thread_number,
    directory_identity, hold_directory_open, process_holds_file_in, process_state, random_token,
    remove_file, signal_reaches,
};

pub(crate) const LOCK_FILE_NAME: &str = ".narsil.lock";

#[derive(Debug, Clone, PartialEq, Eq)]
struct LockHolder {
    pid: u32,
    thread: Option<u64>,
    start_ms: Option<u64>,
    token: Option<String>,
}

enum LockReading {
    Holder(LockHolder),
    Absent,
    Unreadable,
}

fn locked_directories() -> &'static Mutex<HashSet<DirectoryIdentity>> {
    static LOCKED: OnceLock<Mutex<HashSet<DirectoryIdentity>>> = OnceLock::new();
    LOCKED.get_or_init(|| Mutex::new(HashSet::new()))
}

fn parse_holder(text: &str) -> Option<LockHolder> {
    let mut lines = text.split('\n');
    let pid: u32 = lines.next()?.trim().parse().ok().filter(|pid| *pid > 0)?;
    let thread = lines.next().and_then(|line| line.trim().parse().ok());
    let start_ms = lines.next().and_then(|line| line.trim().parse().ok());
    let token = lines
        .next()
        .map(str::trim)
        .filter(|token| !token.is_empty())
        .map(str::to_string);
    Some(LockHolder {
        pid,
        thread,
        start_ms,
        token,
    })
}

fn format_holder(holder: &LockHolder) -> String {
    let optional = |value: Option<u64>| value.map(|value| value.to_string()).unwrap_or_default();
    format!(
        "{}\n{}\n{}\n{}\n",
        holder.pid,
        optional(holder.thread),
        optional(holder.start_ms),
        holder.token.clone().unwrap_or_default()
    )
}

fn read_text(path: &Path) -> io::Result<Option<String>> {
    match File::open(path) {
        Ok(file) => {
            let mut bytes = Vec::new();
            io::Read::read_to_end(&mut io::Read::take(file, MAX_LOCK_FILE_BYTES), &mut bytes)?;
            Ok(Some(String::from_utf8_lossy(&bytes).into_owned()))
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error),
    }
}

fn read_holder(path: &Path) -> io::Result<LockReading> {
    Ok(match read_text(path)? {
        None => LockReading::Absent,
        Some(text) => parse_holder(&text).map_or(LockReading::Unreadable, LockReading::Holder),
    })
}

fn settled_holder(path: &Path) -> io::Result<LockReading> {
    match read_holder(path)? {
        LockReading::Unreadable => {
            std::thread::sleep(Duration::from_millis(DIRECTORY_LOCK_SETTLE_MS));
            read_holder(path)
        }
        reading => Ok(reading),
    }
}

fn holder_is_live(holder: &LockHolder, me: &LockHolder, lock_path: &Path) -> bool {
    let directory = lock_path.parent().unwrap_or(lock_path);
    let within_tolerance = |found: u64, recorded: u64| {
        found.saturating_sub(recorded) <= DIRECTORY_LOCK_PROCESS_START_TOLERANCE_MS
    };
    if holder.pid == me.pid {
        let (Some(recorded), Some(mine)) = (holder.start_ms, me.start_ms) else {
            return false;
        };
        if recorded.abs_diff(mine) <= DIRECTORY_LOCK_PROCESS_START_TOLERANCE_MS {
            return true;
        }
        return process_holds_file_in(holder.pid, directory);
    }
    if !signal_reaches(holder.pid) {
        return false;
    }
    match process_state(holder.pid) {
        ProcessState::Exited => false,
        ProcessState::Unknown => signal_reaches(holder.pid),
        ProcessState::Running(None) => true,
        ProcessState::Running(Some(found)) => match holder.start_ms {
            None => true,
            Some(recorded) if within_tolerance(found, recorded) => true,
            Some(_) => process_holds_file_in(holder.pid, directory),
        },
    }
}

fn held_elsewhere(root: &Path, who: &str, lock_path: &Path) -> NarsilError {
    NarsilError::new(
        ErrorCode::CONFIG_INVALID,
        format!(
            "The durability directory \"{}\" is in use by {who}, and only one engine may write a write-ahead log directory. Point this engine at another directory, or shut the other engine down first. Where no engine uses the directory, delete \"{}\"",
            root.display(),
            lock_path.display()
        ),
    )
}

fn holder_label(holder: &LockHolder, me: &LockHolder) -> String {
    if holder.pid != me.pid {
        return format!("process {}", holder.pid);
    }
    if holder.thread == me.thread {
        "another copy of Narsil in this thread".to_string()
    } else {
        "another thread of this process".to_string()
    }
}

fn link_unsupported(error: &io::Error) -> bool {
    matches!(
        error.kind(),
        io::ErrorKind::PermissionDenied | io::ErrorKind::Unsupported
    ) || matches!(error.raw_os_error(), Some(code) if code == 95 || code == 45 || code == 38 || code == 1)
}

fn create_exclusively(lock_path: &Path, content: &str) -> io::Result<bool> {
    match OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(lock_path)
    {
        Ok(mut file) => {
            file.write_all(content.as_bytes())?;
            file.sync_all()?;
            Ok(true)
        }
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => Ok(false),
        Err(error) => Err(error),
    }
}

fn create_lock_file(lock_path: &Path, draft: &Path, content: &str) -> io::Result<bool> {
    {
        let mut file = File::create(draft)?;
        file.write_all(content.as_bytes())?;
        file.sync_all()?;
    }
    let linked = match std::fs::hard_link(draft, lock_path) {
        Ok(()) => Ok(true),
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => Ok(false),
        Err(error) if link_unsupported(&error) => create_exclusively(lock_path, content),
        Err(error) => Err(error),
    };
    let _ = remove_file(draft);
    linked
}

fn remove_stale_lock(lock_path: &Path, aside: &Path, seen: &LockReading) -> io::Result<()> {
    match std::fs::rename(lock_path, aside) {
        Ok(()) => {}
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error),
    }
    let restored = (|| -> io::Result<()> {
        let moved = read_text(aside)?.unwrap_or_default();
        let still_stale = match (seen, parse_holder(&moved)) {
            (LockReading::Holder(before), Some(now)) => *before == now,
            (LockReading::Unreadable, None) => true,
            _ => false,
        };
        if !still_stale {
            create_exclusively(lock_path, &moved)?;
        }
        Ok(())
    })();
    let _ = remove_file(aside);
    restored
}

fn acquire(root: &Path, lock_path: &Path, me: &LockHolder) -> io::Result<Option<NarsilError>> {
    let draft = PathBuf::from(format!(
        "{}.{}.{}",
        lock_path.display(),
        me.pid,
        me.thread.unwrap_or(0)
    ));
    let aside = PathBuf::from(format!("{}.aside", draft.display()));
    let content = format_holder(me);
    for _ in 0..DIRECTORY_LOCK_ATTEMPTS {
        if create_lock_file(lock_path, &draft, &content)? {
            return Ok(None);
        }
        let reading = settled_holder(lock_path)?;
        if let LockReading::Holder(holder) = &reading
            && holder_is_live(holder, me, lock_path)
        {
            return Ok(Some(held_elsewhere(
                root,
                &holder_label(holder, me),
                lock_path,
            )));
        }
        if !matches!(reading, LockReading::Absent) {
            remove_stale_lock(lock_path, &aside, &reading)?;
        }
    }
    Ok(Some(held_elsewhere(root, "another process", lock_path)))
}

pub(crate) struct DirectoryLock {
    lock_path: PathBuf,
    token: String,
    identity: DirectoryIdentity,
    open_directory: Option<File>,
    released: bool,
}

impl DirectoryLock {
    pub(crate) fn acquire(root: &Path) -> Result<DirectoryLock> {
        let lock_path = root.join(LOCK_FILE_NAME);
        let cannot_lock = |error: io::Error| {
            NarsilError::new(
                ErrorCode::PERSISTENCE_SAVE_FAILED,
                format!(
                    "The engine cannot lock the durability directory \"{}\": {error}",
                    root.display()
                ),
            )
        };
        std::fs::create_dir_all(root).map_err(cannot_lock)?;
        let identity = directory_identity(root).map_err(cannot_lock)?;
        {
            let mut locked = locked_directories()
                .lock()
                .map_err(|_| cannot_lock(io::Error::other("the lock registry is poisoned")))?;
            if !locked.insert(identity) {
                return Err(held_elsewhere(
                    root,
                    "another engine in this process",
                    &lock_path,
                ));
            }
        }
        let token = random_token().map_err(cannot_lock)?;
        let me = LockHolder {
            pid: std::process::id(),
            thread: current_thread_number(),
            start_ms: current_process_start_ms(),
            token: Some(token.clone()),
        };
        let mut lock = DirectoryLock {
            lock_path: lock_path.clone(),
            token,
            identity,
            open_directory: None,
            released: false,
        };
        match acquire(root, &lock_path, &me) {
            Ok(None) => {}
            Ok(Some(refusal)) => {
                lock.release();
                return Err(refusal);
            }
            Err(error) => {
                lock.release();
                return Err(cannot_lock(error));
            }
        }
        lock.open_directory = hold_directory_open(root);
        Ok(lock)
    }

    pub(crate) fn identity(&self) -> DirectoryIdentity {
        self.identity
    }

    pub(crate) fn holds(&self) -> io::Result<bool> {
        Ok(match read_holder(&self.lock_path)? {
            LockReading::Holder(holder) => holder.token.as_deref() == Some(self.token.as_str()),
            _ => false,
        })
    }

    pub(crate) fn release(&mut self) {
        if self.released {
            return;
        }
        self.released = true;
        if let Ok(mut locked) = locked_directories().lock() {
            locked.remove(&self.identity);
        }
        if self.holds().unwrap_or(false) {
            let _ = remove_file(&self.lock_path);
        }
        self.open_directory = None;
    }
}

impl Drop for DirectoryLock {
    fn drop(&mut self) {
        self.release();
    }
}
