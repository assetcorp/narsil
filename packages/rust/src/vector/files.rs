use std::ffi::CString;
use std::path::{Path, PathBuf};
use std::ptr;
use std::sync::Arc;

use crate::error::{ErrorCode, NarsilError, Result};
use crate::ffi;
use crate::util::bytes::le_values;

pub(crate) struct MappedFile {
    raw: ffi::narsil_vector_file,
    path: PathBuf,
}

unsafe impl Send for MappedFile {}
unsafe impl Sync for MappedFile {}

impl Drop for MappedFile {
    fn drop(&mut self) {
        unsafe { ffi::narsil_vector_file_unmap(&mut self.raw) };
    }
}

impl MappedFile {
    pub(crate) fn open(path: &Path) -> Result<Arc<MappedFile>> {
        let unreadable = || {
            NarsilError::new(
                ErrorCode::PERSISTENCE_LOAD_FAILED,
                format!(
                    "The engine cannot map the vector file \"{}\" to read its vectors",
                    path.display()
                ),
            )
        };
        let text = path.to_str().ok_or_else(unreadable)?;
        let name = CString::new(text).map_err(|_| unreadable())?;
        let mut raw = ffi::narsil_vector_file {
            bytes: ptr::null(),
            length: 0,
            mapping: ptr::null_mut(),
        };
        let status = unsafe { ffi::narsil_vector_file_map(name.as_ptr(), &mut raw) };
        if status != ffi::NARSIL_OK || raw.bytes.is_null() {
            return Err(unreadable());
        }
        Ok(Arc::new(MappedFile {
            raw,
            path: path.to_path_buf(),
        }))
    }

    pub(crate) fn path(&self) -> &Path {
        &self.path
    }

    pub(crate) fn length(&self) -> u64 {
        self.raw.length
    }

    pub(crate) fn read_floats(&self, offset: u64, out: &mut [f32]) -> bool {
        let wanted = out.len() as u64 * 4;
        if offset
            .checked_add(wanted)
            .is_none_or(|end| end > self.raw.length)
        {
            return false;
        }
        let bytes = unsafe {
            std::slice::from_raw_parts(self.raw.bytes.add(offset as usize), wanted as usize)
        };
        for (value, number) in out.iter_mut().zip(le_values(bytes, f32::from_le_bytes)) {
            *value = number;
        }
        true
    }

    fn raw_copy(&self) -> ffi::narsil_vector_file {
        ffi::narsil_vector_file {
            bytes: self.raw.bytes,
            length: self.raw.length,
            mapping: self.raw.mapping,
        }
    }
}

pub(crate) struct FileList {
    owners: Vec<Arc<MappedFile>>,
    raw: Box<[ffi::narsil_vector_file]>,
}

unsafe impl Send for FileList {}
unsafe impl Sync for FileList {}

impl FileList {
    pub(crate) fn of(owners: Vec<Arc<MappedFile>>) -> FileList {
        let raw = owners.iter().map(|file| file.raw_copy()).collect();
        FileList { owners, raw }
    }

    pub(crate) fn empty() -> FileList {
        FileList::of(Vec::new())
    }

    pub(crate) fn owners(&self) -> &[Arc<MappedFile>] {
        &self.owners
    }

    pub(crate) fn get(&self, index: usize) -> Option<&Arc<MappedFile>> {
        self.owners.get(index)
    }

    pub(crate) fn len(&self) -> usize {
        self.owners.len()
    }

    pub(crate) fn raw_ptr(&self) -> *const ffi::narsil_vector_file {
        if self.raw.is_empty() {
            ptr::null()
        } else {
            self.raw.as_ptr()
        }
    }
}
