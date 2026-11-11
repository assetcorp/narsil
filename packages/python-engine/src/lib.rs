mod callbacks;
mod constants;
mod convert;
mod engine;
mod errors;
mod io;

use pyo3::PyTypeInfo;
use pyo3::prelude::*;

use crate::callbacks::functions::PyStaleRebuild;
use crate::callbacks::persistence::{PyFilesystemPersistence, PyMemoryPersistence};
use crate::callbacks::reducer::GroupReducerHandle;
use crate::engine::{PyNarsil, PyQuerySuggestions};
use crate::errors::PyNarsilError;

#[pymodule]
fn _native(module: &Bound<'_, PyModule>) -> PyResult<()> {
    let py = module.py();
    py.import("narsil._errors")?;
    PyNarsilError::type_object(py);
    module.add_class::<PyNarsil>()?;
    module.add_class::<PyQuerySuggestions>()?;
    module.add_class::<PyMemoryPersistence>()?;
    module.add_class::<PyFilesystemPersistence>()?;
    module.add_class::<PyStaleRebuild>()?;
    module.add_class::<GroupReducerHandle>()?;
    module.add("VERSION", env!("CARGO_PKG_VERSION"))?;
    Ok(())
}
