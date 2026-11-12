use std::fs::File;
use std::io::{self, BufReader, BufWriter, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use narsil::{ErrorCode, NarsilError};
use pyo3::buffer::PyBuffer;
use pyo3::prelude::*;
use pyo3::types::{PyBool, PyBytes, PyInt, PyString};

use crate::callbacks::reentry::{EngineMark, Reentry, awaited};
use crate::constants::STREAM_BUFFER_BYTES;
use crate::errors::config_invalid;

const PARTIAL_SUFFIX: &str = "partial";
const DESTINATION_SUBJECT: &str = "The destination";
const SOURCE_SUBJECT: &str = "The source";

static PARTIAL_FILES_STARTED: AtomicU64 = AtomicU64::new(0);

pub(crate) enum Sink {
    Memory,
    Path(PathBuf),
    Python(PythonWriter),
}

pub(crate) enum Source {
    Memory(Vec<u8>),
    Path(PathBuf),
    Python(PythonReader),
}

fn is_path(value: &Bound<'_, PyAny>) -> bool {
    value.cast::<PyString>().is_ok() || value.hasattr("__fspath__").unwrap_or(false)
}

pub(crate) fn sink_of(
    value: Option<&Bound<'_, PyAny>>,
    engine: EngineMark,
) -> Result<Sink, NarsilError> {
    let Some(value) = value.filter(|value| !value.is_none()) else {
        return Ok(Sink::Memory);
    };
    if is_path(value) {
        let path = value
            .extract::<PathBuf>()
            .map_err(|_| config_invalid("destination must be a path or a writable binary file"))?;
        return Ok(Sink::Path(path));
    }
    if value
        .getattr("write")
        .map(|write| write.is_callable())
        .unwrap_or(false)
    {
        return Ok(Sink::Python(PythonWriter {
            file: value.clone().unbind(),
            engine,
        }));
    }
    Err(config_invalid(
        "destination must be None, a path, or a writable binary file",
    ))
}

pub(crate) fn source_of(
    value: &Bound<'_, PyAny>,
    engine: EngineMark,
) -> Result<Source, NarsilError> {
    if is_path(value) {
        let path = value.extract::<PathBuf>().map_err(|_| {
            config_invalid("source must be bytes, a path, or a readable binary file")
        })?;
        return Ok(Source::Path(path));
    }
    if let Ok(bytes) = value.cast::<PyBytes>() {
        return Ok(Source::Memory(bytes.as_bytes().to_vec()));
    }
    if let Ok(buffer) = PyBuffer::<u8>::get(value) {
        let bytes = buffer
            .to_vec(value.py())
            .map_err(|error| config_invalid(format!("source cannot be read as bytes: {error}")))?;
        return Ok(Source::Memory(bytes));
    }
    if value
        .getattr("read")
        .map(|read| read.is_callable())
        .unwrap_or(false)
    {
        return Ok(Source::Python(PythonReader {
            file: value.clone().unbind(),
            engine,
        }));
    }
    Err(config_invalid(
        "source must be bytes, a path, or a readable binary file",
    ))
}

fn python_io_error(error: PyErr) -> io::Error {
    io::Error::other(error.to_string())
}

fn finalizing() -> io::Error {
    io::Error::other("the Python interpreter is shutting down")
}

fn is_raw_stream(file: &Bound<'_, PyAny>) -> io::Result<bool> {
    let raw_type = file
        .py()
        .import("io")
        .and_then(|module| module.getattr("RawIOBase"))
        .map_err(python_io_error)?;
    file.is_instance(&raw_type).map_err(python_io_error)
}

pub(crate) struct PythonWriter {
    file: Py<PyAny>,
    engine: EngineMark,
}

impl Write for PythonWriter {
    fn write(&mut self, buffer: &[u8]) -> io::Result<usize> {
        Python::try_attach(|py| {
            let _awaited = awaited(Reentry::Refused(self.engine), DESTINATION_SUBJECT);
            let written = self
                .file
                .bind(py)
                .call_method1("write", (PyBytes::new(py, buffer),))
                .map_err(python_io_error)?;
            if written.is_none() {
                if is_raw_stream(self.file.bind(py))? {
                    return Err(io::Error::new(
                        io::ErrorKind::WouldBlock,
                        "the nonblocking stream accepted none of the bytes",
                    ));
                }
                return Ok(buffer.len());
            }
            let count = (written.is_instance_of::<PyInt>() && !written.is_instance_of::<PyBool>())
                .then(|| written.extract::<usize>().ok())
                .flatten()
                .filter(|count| *count <= buffer.len() && (*count > 0 || buffer.is_empty()));
            count.ok_or_else(|| {
                let shown = written
                    .repr()
                    .map(|text| text.to_string_lossy().into_owned())
                    .unwrap_or_else(|_| "an object".to_string());
                io::Error::other(format!(
                    "write() returned {shown} for {} bytes, where it returns None or the number of bytes that it wrote, from 1 to {}",
                    buffer.len(),
                    buffer.len()
                ))
            })
        })
        .unwrap_or_else(|| Err(finalizing()))
    }

    fn flush(&mut self) -> io::Result<()> {
        Python::try_attach(|py| {
            let _awaited = awaited(Reentry::Refused(self.engine), DESTINATION_SUBJECT);
            let file = self.file.bind(py);
            if file.hasattr("flush").unwrap_or(false) {
                file.call_method0("flush").map_err(python_io_error)?;
            }
            Ok(())
        })
        .unwrap_or_else(|| Err(finalizing()))
    }
}

pub(crate) struct PythonReader {
    file: Py<PyAny>,
    engine: EngineMark,
}

impl Read for PythonReader {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        Python::try_attach(|py| {
            let _awaited = awaited(Reentry::Refused(self.engine), SOURCE_SUBJECT);
            let chunk = self
                .file
                .bind(py)
                .call_method1("read", (buffer.len(),))
                .map_err(python_io_error)?;
            let chunk = chunk
                .cast::<PyBytes>()
                .map_err(|_| io::Error::other("read() must return bytes"))?
                .as_bytes();
            if chunk.len() > buffer.len() {
                return Err(io::Error::other(format!(
                    "read({}) returned {} bytes",
                    buffer.len(),
                    chunk.len()
                )));
            }
            buffer[..chunk.len()].copy_from_slice(chunk);
            Ok(chunk.len())
        })
        .unwrap_or_else(|| Err(finalizing()))
    }
}

fn save_failed(path: &Path, error: impl std::fmt::Display) -> NarsilError {
    NarsilError::new(
        ErrorCode::PERSISTENCE_SAVE_FAILED,
        format!("The engine cannot write {}: {error}", path.display()),
    )
}

fn partial_path(path: &Path) -> PathBuf {
    let mut name = path
        .file_name()
        .map(|name| name.to_os_string())
        .unwrap_or_default();
    let attempt = PARTIAL_FILES_STARTED.fetch_add(1, Ordering::Relaxed);
    name.push(format!(
        ".{}.{attempt}.{PARTIAL_SUFFIX}",
        std::process::id()
    ));
    path.with_file_name(name)
}

fn write_file(
    path: &Path,
    write: impl FnOnce(&mut dyn Write) -> narsil::Result<()>,
) -> narsil::Result<()> {
    let partial = partial_path(path);
    let outcome = (|| {
        let file = File::create(&partial).map_err(|error| save_failed(&partial, error))?;
        let mut writer = BufWriter::with_capacity(STREAM_BUFFER_BYTES, file);
        write(&mut writer)?;
        let file = writer
            .into_inner()
            .map_err(|error| save_failed(&partial, error.error()))?;
        file.sync_all()
            .map_err(|error| save_failed(&partial, error))?;
        std::fs::rename(&partial, path).map_err(|error| save_failed(path, error))
    })();
    if outcome.is_err() {
        let _ = std::fs::remove_file(&partial);
    }
    outcome
}

pub(crate) fn write_to(
    sink: Sink,
    write: impl FnOnce(&mut dyn Write) -> narsil::Result<()>,
) -> narsil::Result<Option<Vec<u8>>> {
    match sink {
        Sink::Memory => {
            let mut bytes = Vec::new();
            write(&mut bytes)?;
            Ok(Some(bytes))
        }
        Sink::Path(path) => write_file(&path, write).map(|()| None),
        Sink::Python(file) => {
            let mut writer = BufWriter::with_capacity(STREAM_BUFFER_BYTES, file);
            write(&mut writer)?;
            writer.flush().map_err(|error| {
                NarsilError::new(
                    ErrorCode::PERSISTENCE_SAVE_FAILED,
                    format!("The engine cannot write the destination: {error}"),
                )
            })?;
            Ok(None)
        }
    }
}

pub(crate) fn read_from<T>(
    source: Source,
    read: impl FnOnce(&mut dyn Read) -> narsil::Result<T>,
) -> narsil::Result<T> {
    match source {
        Source::Memory(bytes) => read(&mut bytes.as_slice()),
        Source::Path(path) => {
            let file = File::open(&path).map_err(|error| {
                NarsilError::new(
                    ErrorCode::PERSISTENCE_LOAD_FAILED,
                    format!("The engine cannot read {}: {error}", path.display()),
                )
            })?;
            read(&mut BufReader::with_capacity(STREAM_BUFFER_BYTES, file))
        }
        Source::Python(file) => read(&mut BufReader::with_capacity(STREAM_BUFFER_BYTES, file)),
    }
}
