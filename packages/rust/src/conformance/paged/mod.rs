mod lists;
mod read;
mod sections;
mod write;

pub(crate) use read::read_paged_segment;
pub(crate) use write::write_paged_segment;

const WHAT: &str = "paged segment";
