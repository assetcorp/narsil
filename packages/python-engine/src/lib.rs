mod callbacks;
mod constants;
mod convert;
mod engine;
mod errors;
mod io;

use pyo3::prelude::*;

use crate::callbacks::functions::{GroupReducerHandle, PyStaleRebuild};
use crate::callbacks::persistence::{PyFilesystemPersistence, PyMemoryPersistence};
use crate::engine::{PyNarsil, PyQuerySuggestions};

#[pymodule]
fn _native(module: &Bound<'_, PyModule>) -> PyResult<()> {
    module.add_class::<PyNarsil>()?;
    module.add_class::<PyQuerySuggestions>()?;
    module.add_class::<PyMemoryPersistence>()?;
    module.add_class::<PyFilesystemPersistence>()?;
    module.add_class::<PyStaleRebuild>()?;
    module.add_class::<GroupReducerHandle>()?;
    module.add("VERSION", env!("CARGO_PKG_VERSION"))?;
    Ok(())
}
