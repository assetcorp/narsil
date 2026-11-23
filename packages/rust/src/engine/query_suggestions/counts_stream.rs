use std::sync::Arc;

use super::constants::{
    COUNTS_STREAM_CHUNK_BYTES, MAX_COUNTS_STREAM_KEY_BYTES, MAX_HISTORY_FILE_BYTES,
};
use super::history_files::{
    HistoryRead, history_file_of, history_files_of, history_folder_of, read_history_file,
};
use super::host::SuggestionsOwner;
use crate::error::Result;

const KEY_LENGTH_BYTES: usize = 2;
const FILE_LENGTH_BYTES: usize = 4;

/// A query history file that a counts stream carried, under its key in the history folder of the index.
pub struct StreamedHistoryFile {
    /// The key of the file in the history folder of the index.
    pub key: String,
    /// The bytes of the file.
    pub bytes: Vec<u8>,
}

/// The chunks of the counts stream that a node sends for one index: each history file of the index, in code
/// point order of its key, as a frame of its key and length followed by its bytes, or one empty chunk where the
/// node keeps none.
pub struct HistoryStream {
    owner: Arc<dyn SuggestionsOwner>,
    folder_length: usize,
    keys: std::vec::IntoIter<String>,
    file: Vec<u8>,
    offset: usize,
    sent: bool,
    finished: bool,
}

fn frame_header(relative_key: &[u8], file_bytes: usize) -> Option<Vec<u8>> {
    let key_length = u16::try_from(relative_key.len()).ok()?;
    let file_length = u32::try_from(file_bytes).ok()?;
    let mut header = Vec::with_capacity(KEY_LENGTH_BYTES + relative_key.len() + FILE_LENGTH_BYTES);
    header.extend_from_slice(&key_length.to_be_bytes());
    header.extend_from_slice(relative_key);
    header.extend_from_slice(&file_length.to_be_bytes());
    Some(header)
}

impl HistoryStream {
    pub(crate) fn open(
        owner: Arc<dyn SuggestionsOwner>,
        index_name: &str,
    ) -> Result<HistoryStream> {
        let mut keys: Vec<String> = history_files_of(owner.host().files().store(), index_name)?
            .into_iter()
            .map(|file| file.key)
            .collect();
        keys.sort();
        Ok(HistoryStream {
            owner,
            folder_length: history_folder_of(index_name).len(),
            keys: keys.into_iter(),
            file: Vec::new(),
            offset: 0,
            sent: false,
            finished: false,
        })
    }

    /// Returns the next chunk of the stream, or `None` once the stream holds no more.
    ///
    /// # Errors
    ///
    /// Fails with the error of the store where a file cannot be read.
    pub fn next_chunk(&mut self) -> Result<Option<Vec<u8>>> {
        if self.offset < self.file.len() {
            let end = self.file.len().min(self.offset + COUNTS_STREAM_CHUNK_BYTES);
            let chunk = self.file[self.offset..end].to_vec();
            self.offset = end;
            return Ok(Some(chunk));
        }
        let store = self.owner.host().files().store();
        for key in self.keys.by_ref() {
            let HistoryRead::Bytes(bytes) = read_history_file(store, &key)? else {
                continue;
            };
            let Some(header) = frame_header(&key.as_bytes()[self.folder_length..], bytes.len())
            else {
                continue;
            };
            self.sent = true;
            self.file = bytes;
            self.offset = 0;
            return Ok(Some(header));
        }
        if self.sent || self.finished {
            return Ok(None);
        }
        self.finished = true;
        Ok(Some(Vec::new()))
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum ReaderPart {
    KeyLength,
    Key,
    FileLength,
    File,
}

/// Reads the counts stream of another node for one index, frame by frame, and refuses the whole stream at the
/// first frame that breaks a rule.
pub struct HistoryStreamReader {
    index_name: String,
    folder: String,
    part: ReaderPart,
    need: usize,
    buffer: Vec<u8>,
    key: String,
    refused_for: Option<String>,
}

impl HistoryStreamReader {
    /// Returns a reader of the counts stream of `index_name`.
    pub fn new(index_name: &str) -> HistoryStreamReader {
        HistoryStreamReader {
            index_name: index_name.to_string(),
            folder: history_folder_of(index_name),
            part: ReaderPart::KeyLength,
            need: KEY_LENGTH_BYTES,
            buffer: Vec::with_capacity(KEY_LENGTH_BYTES),
            key: String::new(),
            refused_for: None,
        }
    }

    /// Returns why the reader refused the stream, or `None` while it accepts every frame.
    pub fn refusal(&self) -> Option<&str> {
        self.refused_for.as_deref()
    }

    /// Reports whether the stream ended between two frames with nothing refused.
    pub fn ends_cleanly(&self) -> bool {
        self.refused_for.is_none() && self.part == ReaderPart::KeyLength && self.buffer.is_empty()
    }

    /// Reads `chunk` and returns each file that it completed.
    pub fn push(&mut self, chunk: &[u8]) -> Vec<StreamedHistoryFile> {
        let mut complete = Vec::new();
        let mut at = 0;
        while at < chunk.len() && self.refused_for.is_none() {
            let taken = (self.need - self.buffer.len()).min(chunk.len() - at);
            self.buffer.extend_from_slice(&chunk[at..at + taken]);
            at += taken;
            if self.buffer.len() == self.need {
                self.advance(&mut complete);
            }
        }
        complete
    }

    fn expect(&mut self, part: ReaderPart, bytes: usize) {
        self.part = part;
        self.need = bytes;
        self.buffer = Vec::with_capacity(bytes.min(COUNTS_STREAM_CHUNK_BYTES));
    }

    fn refuse(&mut self, reason: String) {
        self.refused_for = Some(reason);
        self.buffer = Vec::new();
    }

    fn advance(&mut self, complete: &mut Vec<StreamedHistoryFile>) {
        match self.part {
            ReaderPart::KeyLength => {
                let length = usize::from(u16::from_be_bytes([self.buffer[0], self.buffer[1]]));
                if length == 0 || length > MAX_COUNTS_STREAM_KEY_BYTES {
                    self.refuse(format!("a key length of {length} bytes"));
                    return;
                }
                self.expect(ReaderPart::Key, length);
            }
            ReaderPart::Key => {
                let Ok(relative) = std::str::from_utf8(&self.buffer) else {
                    self.refuse("a key that is not UTF-8".to_string());
                    return;
                };
                let key = format!("{}{relative}", self.folder);
                if history_file_of(&self.index_name, &key).is_none() {
                    self.refuse("a key that names no history file".to_string());
                    return;
                }
                self.key = key;
                self.expect(ReaderPart::FileLength, FILE_LENGTH_BYTES);
            }
            ReaderPart::FileLength => {
                let bytes = [
                    self.buffer[0],
                    self.buffer[1],
                    self.buffer[2],
                    self.buffer[3],
                ];
                let length = u32::from_be_bytes(bytes);
                if u64::from(length) > MAX_HISTORY_FILE_BYTES {
                    self.refuse(format!("a file of {length} bytes"));
                    return;
                }
                if length == 0 {
                    complete.push(StreamedHistoryFile {
                        key: std::mem::take(&mut self.key),
                        bytes: Vec::new(),
                    });
                    self.expect(ReaderPart::KeyLength, KEY_LENGTH_BYTES);
                    return;
                }
                self.expect(ReaderPart::File, length as usize);
            }
            ReaderPart::File => {
                complete.push(StreamedHistoryFile {
                    key: std::mem::take(&mut self.key),
                    bytes: std::mem::take(&mut self.buffer),
                });
                self.expect(ReaderPart::KeyLength, KEY_LENGTH_BYTES);
            }
        }
    }
}
