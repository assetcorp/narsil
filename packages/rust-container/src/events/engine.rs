use narsil::{
    EarlierLayout, Narsil, NarsilError, NarsilEvent, NarsilEventKind, QuerySuggestionsBuildPhase,
    Value, WorkStatus,
};

use super::body::{error_value, object};
use super::sink::EventSink;
use super::types::engine_type;

const PUBLISHED_KINDS: [NarsilEventKind; 7] = [
    NarsilEventKind::PartitionRebalance,
    NarsilEventKind::PartitionWatermark,
    NarsilEventKind::AnalysisRebuild,
    NarsilEventKind::LayoutUpgrade,
    NarsilEventKind::DurabilityError,
    NarsilEventKind::QuerySuggestionsBuild,
    NarsilEventKind::QuerySuggestionsWarning,
];

fn text(value: &str) -> Value {
    Value::String(value.to_string())
}

fn size(value: usize) -> Value {
    Value::Number(value as f64)
}

fn whole(value: u64) -> Value {
    Value::Number(value as f64)
}

fn work_status(status: WorkStatus) -> Value {
    text(match status {
        WorkStatus::Started => "started",
        WorkStatus::Completed => "completed",
        WorkStatus::Failed => "failed",
    })
}

fn layout_name(layout: EarlierLayout) -> Value {
    text(match layout {
        EarlierLayout::Manifest => "manifest",
        EarlierLayout::Bundle => "bundle",
    })
}

fn phase_name(phase: QuerySuggestionsBuildPhase) -> Value {
    text(match phase {
        QuerySuggestionsBuildPhase::Started => "started",
        QuerySuggestionsBuildPhase::Completed => "completed",
        QuerySuggestionsBuildPhase::Failed => "failed",
        QuerySuggestionsBuildPhase::Skipped => "skipped",
    })
}

fn with_optional(
    mut entries: Vec<(&'static str, Value)>,
    key: &'static str,
    value: Option<Value>,
) -> Vec<(&'static str, Value)> {
    if let Some(value) = value {
        entries.push((key, value));
    }
    entries
}

fn optional_error(error: &Option<NarsilError>) -> Option<Value> {
    error.as_ref().map(error_value)
}

fn payload_of(event: &NarsilEvent) -> Option<(&'static str, Value)> {
    let payload = match event {
        NarsilEvent::PartitionRebalance {
            index_name,
            old_count,
            new_count,
        } => (
            "partitionRebalance",
            vec![
                ("indexName", text(index_name)),
                ("oldCount", size(*old_count)),
                ("newCount", size(*new_count)),
            ],
        ),
        NarsilEvent::PartitionWatermark {
            index_name,
            document_count,
            capacity,
            partition_count,
        } => (
            "partitionWatermark",
            vec![
                ("indexName", text(index_name)),
                ("documentCount", whole(*document_count)),
                ("capacity", whole(*capacity)),
                ("partitionCount", size(*partition_count)),
            ],
        ),
        NarsilEvent::AnalysisRebuild {
            index_name,
            status,
            partitions_rebuilt,
            partition_count,
            error,
        } => (
            "analysisRebuild",
            with_optional(
                vec![
                    ("indexName", text(index_name)),
                    ("status", work_status(*status)),
                    ("partitionsRebuilt", size(*partitions_rebuilt)),
                    ("partitionCount", size(*partition_count)),
                ],
                "error",
                optional_error(error),
            ),
        ),
        NarsilEvent::LayoutUpgrade {
            index_name,
            status,
            layout,
            error,
        } => (
            "layoutUpgrade",
            with_optional(
                vec![
                    ("indexName", text(index_name)),
                    ("status", work_status(*status)),
                    ("layout", layout_name(*layout)),
                ],
                "error",
                optional_error(error),
            ),
        ),
        NarsilEvent::DurabilityError { index_name, error } => (
            "durabilityError",
            vec![
                ("indexName", text(index_name)),
                ("error", error_value(error)),
            ],
        ),
        NarsilEvent::QuerySuggestionsBuild {
            index_name,
            build_id,
            phase,
            trigger,
            published,
            removed,
            discarded,
            error_code,
        } => (
            "querySuggestionsBuild",
            with_optional(
                vec![
                    ("indexName", text(index_name)),
                    ("buildId", text(build_id)),
                    ("phase", phase_name(*phase)),
                    ("trigger", text(trigger.as_str())),
                    ("published", whole(*published)),
                    ("removed", whole(*removed)),
                    ("discarded", whole(*discarded)),
                ],
                "errorCode",
                error_code.as_deref().map(text),
            ),
        ),
        NarsilEvent::QuerySuggestionsWarning {
            index_name,
            reason,
            file,
            message,
        } => {
            let entries = vec![
                ("indexName", text(index_name)),
                ("reason", text(reason.as_str())),
            ];
            let entries = with_optional(entries, "file", file.as_deref().map(text));
            (
                "querySuggestionsWarning",
                with_optional(entries, "message", message.as_deref().map(text)),
            )
        }
        _ => return None,
    };
    Some((payload.0, object(payload.1)))
}

pub fn publish_engine_events(engine: &Narsil, sink: &EventSink) {
    for kind in PUBLISHED_KINDS {
        let sink = sink.clone();
        engine.on(kind, move |event| {
            if let Some((name, data)) = payload_of(event) {
                sink.publish(&engine_type(name), data);
            }
        });
    }
}
