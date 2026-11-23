#[path = "../support/mod.rs"]
mod support;

mod child_node;
mod data_node;
mod ledger;
mod named_analysis;
mod rounds;
mod spread;
mod typescript_node;

mod admission_under_writes;
mod chained_resend;
mod client_writes;
mod controller_lost_copy;
mod controller_node_churn;
mod copy_failure;
mod data_node_adopted_settings;
mod data_node_allocation;
mod data_node_local_copies;
mod dropped_without_controller;
mod grpc_goaway_drain;
mod killed_primary;
mod lost_copy_wait;
mod mixed_analysis_change;
mod mixed_catch_up;
mod mixed_failover;
mod mixed_rebalance_request;
mod mixed_settings;
mod mixed_writes;
mod primary_writes;
mod replica_catch_up;
mod replica_entries;
mod replication_factor_change;
mod rollback;
mod shared_connect;
mod term_start;
