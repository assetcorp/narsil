pub const ENGINE_TYPE_PREFIX: &str = "engine.";
pub const TASK_FINISHED_TYPE: &str = "task.finished";
pub const WEBHOOK_DROPPED_TYPE: &str = "webhook.dropped";
pub const WEBHOOK_STOPPED_TYPE: &str = "webhook.stopped";
pub const WEBHOOK_PERSISTENCE_ERROR_TYPE: &str = "webhook.persistenceError";

pub const ENGINE_EVENT_NAMES: [&str; 13] = [
    "workerCrash",
    "workerPromote",
    "workerPromoteFailure",
    "partitionRebalance",
    "partitionWatermark",
    "heapPressure",
    "analysisRebuild",
    "layoutUpgrade",
    "checkpointHeld",
    "durabilityError",
    "invalidationError",
    "querySuggestionsBuild",
    "querySuggestionsWarning",
];

pub fn is_event_type(candidate: &str) -> bool {
    candidate == TASK_FINISHED_TYPE
        || candidate
            .strip_prefix(ENGINE_TYPE_PREFIX)
            .is_some_and(|name| ENGINE_EVENT_NAMES.contains(&name))
}

pub fn engine_type(name: &str) -> String {
    format!("{ENGINE_TYPE_PREFIX}{name}")
}
