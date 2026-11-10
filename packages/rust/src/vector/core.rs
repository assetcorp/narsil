use std::cell::RefCell;
use std::ptr;

use crate::error::Result;
use crate::ffi;
use crate::native::status::core_failed;
use crate::native::workspace::CoreWorkspace;
use crate::pins::thread_slot;

use super::graph::GraphTables;
use super::store::StoreTables;

pub(crate) struct Scratch {
    workspace: CoreWorkspace,
    slot: u32,
    pub(crate) ordinals: Vec<i32>,
    pub(crate) distances: Vec<f64>,
    pub(crate) batch: Vec<i32>,
    pub(crate) scores: Vec<f64>,
}

fn created_scratch() -> Result<Scratch> {
    Ok(Scratch {
        workspace: CoreWorkspace::create()?,
        slot: thread_slot()?,
        ordinals: Vec::new(),
        distances: Vec::new(),
        batch: Vec::new(),
        scores: Vec::new(),
    })
}

thread_local! {
    static SCRATCH: RefCell<Option<Scratch>> = const { RefCell::new(None) };
}

pub(crate) fn with_scratch<T>(work: impl FnOnce(&mut Scratch) -> Result<T>) -> Result<T> {
    SCRATCH.with(|cell| match cell.try_borrow_mut() {
        Ok(mut held) => {
            if held.is_none() {
                *held = Some(created_scratch()?);
            }
            match held.as_mut() {
                Some(scratch) => work(scratch),
                None => work(&mut created_scratch()?),
            }
        }
        Err(_) => work(&mut created_scratch()?),
    })
}

fn checked(status: ffi::narsil_status, what: &str) -> Result<()> {
    if status == ffi::NARSIL_OK {
        Ok(())
    } else {
        Err(core_failed(status, what))
    }
}

fn ordinals_request(metric: u32, ordinals: &[i32]) -> ffi::narsil_ordinals_request {
    ffi::narsil_ordinals_request {
        metric,
        ordinals: ordinals.as_ptr(),
        count: ordinals.len() as u32,
    }
}

pub(crate) struct GraphSearch<'a> {
    pub(crate) query: &'a [f32],
    pub(crate) metric: u32,
    pub(crate) candidates: usize,
    pub(crate) accepted: Option<&'a [u8]>,
    pub(crate) pin: i64,
}

impl Scratch {
    pub(crate) fn search(
        &mut self,
        store: &StoreTables,
        graph: &GraphTables,
        search: &GraphSearch<'_>,
    ) -> Result<usize> {
        let candidates = search.candidates;
        self.ordinals.resize(candidates, 0);
        self.distances.resize(candidates, 0.0);
        let raw_store = store.raw();
        let raw_graph = graph.raw();
        let request = ffi::narsil_search_request {
            query: search.query.as_ptr(),
            metric: search.metric,
            candidate_count: candidates as u32,
            thread_slot: self.slot,
            accepted: match search.accepted {
                Some(bits) => ffi::narsil_ordinal_set {
                    bits: bits.as_ptr(),
                    bytes: bits.len() as u32,
                },
                None => ffi::narsil_ordinal_set {
                    bits: ptr::null(),
                    bytes: 0,
                },
            },
            pin: search.pin,
        };
        let mut nearest = ffi::narsil_candidates {
            ordinals: self.ordinals.as_mut_ptr(),
            distances: self.distances.as_mut_ptr(),
            capacity: candidates as u32,
            count: 0,
        };
        let status = unsafe {
            ffi::narsil_search(
                self.workspace.handle(),
                &raw_graph,
                &raw_store,
                &request,
                &mut nearest,
            )
        };
        checked(status, "search a vector graph")?;
        Ok((nearest.count as usize).min(candidates))
    }

    pub(crate) fn score(
        &mut self,
        store: &StoreTables,
        query: &[f32],
        metric: u32,
        ordinals: &[i32],
        pin: i64,
    ) -> Result<()> {
        self.scores.resize(ordinals.len(), 0.0);
        if ordinals.is_empty() {
            return Ok(());
        }
        let raw_store = store.raw();
        let request = ffi::narsil_score_request {
            query: query.as_ptr(),
            metric,
            ordinals: ordinals.as_ptr(),
            count: ordinals.len() as u32,
            pin,
        };
        let status = unsafe {
            ffi::narsil_score(
                self.workspace.handle(),
                &raw_store,
                &request,
                self.scores.as_mut_ptr(),
            )
        };
        checked(status, "score vectors")
    }

    pub(crate) fn place(
        &mut self,
        store: &StoreTables,
        graph: &GraphTables,
        metric: u32,
        ordinal: u32,
        top_layer: u8,
        held_alone: bool,
    ) -> ffi::narsil_status {
        let raw_store = store.raw();
        let raw_graph = graph.raw();
        let request = ffi::narsil_place_request {
            metric,
            ordinal: ordinal as i32,
            top_layer: i32::from(top_layer),
            thread_slot: self.slot,
            graph_held_alone: if held_alone {
                ffi::NARSIL_GRAPH_HELD_ALONE
            } else {
                0
            },
        };
        unsafe { ffi::narsil_place(self.workspace.handle(), &raw_graph, &raw_store, &request) }
    }

    pub(crate) fn remove(&mut self, graph: &GraphTables, ordinal: u32) -> Result<()> {
        let raw_graph = graph.raw();
        let request = ffi::narsil_remove_request {
            ordinal: ordinal as i32,
            thread_slot: self.slot,
        };
        checked(
            unsafe { ffi::narsil_remove(&raw_graph, &request) },
            "mark a vector as removed",
        )
    }

    pub(crate) fn compact(
        &mut self,
        store: &StoreTables,
        graph: &GraphTables,
        metric: u32,
    ) -> Result<()> {
        let raw_store = store.raw();
        let raw_graph = graph.raw();
        let request = ffi::narsil_compact_request {
            metric,
            thread_slot: self.slot,
        };
        let status = unsafe {
            ffi::narsil_compact(self.workspace.handle(), &raw_graph, &raw_store, &request)
        };
        checked(status, "compact a vector graph")
    }

    pub(crate) fn connect(
        &mut self,
        store: &StoreTables,
        graph: &GraphTables,
        metric: u32,
        nearby: &[i32],
    ) -> Result<()> {
        let raw_store = store.raw();
        let raw_graph = graph.raw();
        let request = ffi::narsil_connect_request {
            metric,
            thread_slot: self.slot,
            nearby: if nearby.is_empty() {
                ptr::null()
            } else {
                nearby.as_ptr()
            },
            nearby_count: nearby.len() as u32,
        };
        let status = unsafe {
            ffi::narsil_connect_unreached(self.workspace.handle(), &raw_graph, &raw_store, &request)
        };
        checked(status, "connect the unreached nodes of a vector graph")
    }

    pub(crate) fn quantise(
        &mut self,
        store: &StoreTables,
        metric: u32,
        ordinals: &[i32],
    ) -> Result<()> {
        if ordinals.is_empty() || store.bits == 0 || !store.calibrated() {
            return Ok(());
        }
        let raw_store = store.raw();
        let request = ordinals_request(metric, ordinals);
        let status = unsafe { ffi::narsil_quantise(self.workspace.handle(), &raw_store, &request) };
        checked(status, "code vectors")
    }

    pub(crate) fn measure(
        &mut self,
        store: &StoreTables,
        metric: u32,
        ordinals: &[i32],
        totals: &mut [f64],
    ) -> Result<()> {
        if ordinals.is_empty() || totals.len() != store.dimension + 2 {
            return Ok(());
        }
        let raw_store = store.raw();
        let request = ordinals_request(metric, ordinals);
        let status = unsafe {
            ffi::narsil_measure(
                self.workspace.handle(),
                &raw_store,
                &request,
                totals.as_mut_ptr(),
            )
        };
        checked(status, "measure vectors")
    }

    pub(crate) fn workspace_bytes(&self) -> usize {
        unsafe { ffi::narsil_workspace_bytes(self.workspace.handle()) }
    }
}
