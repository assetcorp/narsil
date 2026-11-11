mod support;

use std::io::{self, Read};
use std::path::Path;
use std::sync::mpsc::{Receiver, Sender, channel};
use std::time::Duration;

use narsil::{
    DurabilityConfig, ErrorCode, IndexConfig, Map, Narsil, NarsilConfig, Value, parse_json,
};
use support::ScratchDirectory;

const INDEX: &str = "notes";
const STALLED_RESTORE_START: Duration = Duration::from_secs(30);
const STALLED_RESTORE_RELEASE: Duration = Duration::from_secs(120);

fn log_tier(root: &Path) -> NarsilConfig {
    NarsilConfig {
        durability: Some(DurabilityConfig {
            directory: Some(root.to_path_buf()),
            ..DurabilityConfig::default()
        }),
        ..NarsilConfig::default()
    }
}

fn titled_index() -> IndexConfig {
    IndexConfig {
        schema: parse_json(r#"{"title": "string"}"#).expect("the schema is JSON"),
        ..IndexConfig::default()
    }
}

fn note(id: &str, title: &str) -> Map {
    let mut map = Map::new();
    map.insert("id", Value::String(id.to_string()));
    map.insert("title", Value::String(title.to_string()));
    map
}

fn archive_of_one_note() -> Vec<u8> {
    let source = Narsil::new();
    source
        .create_index(INDEX, titled_index())
        .expect("the source index is created");
    source
        .insert(INDEX, note("archived", "held only by the archive"), None)
        .expect("the archived note is inserted");
    let mut archive = Vec::new();
    source
        .snapshot(INDEX, &mut archive)
        .expect("the snapshot is written");
    archive
}

struct StallingArchive {
    bytes: Vec<u8>,
    at: usize,
    stall_at: usize,
    reached: Option<Sender<()>>,
    release: Receiver<()>,
}

impl Read for StallingArchive {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        if self.at >= self.stall_at
            && let Some(reached) = self.reached.take()
        {
            let _ = reached.send(());
            let _ = self.release.recv_timeout(STALLED_RESTORE_RELEASE);
        }
        let end = if self.at < self.stall_at {
            self.stall_at
        } else {
            self.bytes.len()
        };
        let count = buffer.len().min(end - self.at);
        buffer[..count].copy_from_slice(&self.bytes[self.at..self.at + count]);
        self.at += count;
        Ok(count)
    }
}

fn title_of(narsil: &Narsil, id: &str) -> Option<Value> {
    narsil
        .get(INDEX, id)
        .expect("the read answers")
        .and_then(|document| document.get("title").cloned())
}

#[test]
fn a_restore_stalled_on_its_input_changes_no_file_after_the_engine_shuts_down() {
    let root = ScratchDirectory::new("shutdown-beside-restore");
    let bytes = archive_of_one_note();
    let stopped = Narsil::open(log_tier(root.path())).expect("the first engine opens");
    stopped
        .create_index(INDEX, titled_index())
        .expect("the index is created");
    stopped
        .insert(INDEX, note("earlier", "written before the restore"), None)
        .expect("the earlier note is inserted");
    let (reached, reached_receiver) = channel();
    let (release, release_receiver) = channel();
    let mut archive = StallingArchive {
        stall_at: bytes.len() / 2,
        bytes,
        at: 0,
        reached: Some(reached),
        release: release_receiver,
    };

    std::thread::scope(|scope| {
        let restore = scope.spawn(|| stopped.restore(INDEX, &mut archive));
        reached_receiver
            .recv_timeout(STALLED_RESTORE_START)
            .expect("the restore reads half of its archive");
        stopped.shutdown().expect("the first engine shuts down");

        let successor = Narsil::open(log_tier(root.path()))
            .expect("the directory opens once the earlier engine has shut down");
        successor
            .insert(INDEX, note("kept", "written by the next engine"), None)
            .expect("the next engine writes to the directory that it owns");
        let _ = release.send(());
        let refused = restore
            .join()
            .expect("the stalled restore returns")
            .expect_err("a restore that the shutdown overtook is refused");
        assert_eq!(refused.code(), ErrorCode::INSTANCE_SHUT_DOWN);
        assert_eq!(title_of(&successor, "archived"), None);
        successor.shutdown().expect("the next engine shuts down");
    });

    let recovered = Narsil::open(log_tier(root.path())).expect("the last engine opens");
    assert_eq!(
        title_of(&recovered, "kept"),
        Some(Value::String("written by the next engine".to_string())),
        "the next engine's write survives the refused restore"
    );
    assert_eq!(
        title_of(&recovered, "earlier"),
        Some(Value::String("written before the restore".to_string()))
    );
    assert_eq!(
        title_of(&recovered, "archived"),
        None,
        "no file of the refused restore reaches the index"
    );
    recovered.shutdown().expect("the last engine shuts down");
}
