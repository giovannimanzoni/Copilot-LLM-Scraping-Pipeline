export const K = {
	repos_pending: "{repos}:pending",            // SET
	repos_assigned: "{repos}:assigned",          // ZSET score=timestamp
	repos_done: "{repos}:done",                  // SET
	repos_problematic: "{repos}:problematic",    // SET of repo URLs that permanently failed phase 1
	repos_cancelled: "{repos}:cancelled",        // SET of repo URLs that are not found (deleted/renamed) — never retried
	repos_retry_queue: "{repos}:retry_queue",    // LIST of repos waiting for sequential retry (FIFO)
	repos_retry_active: "{repos}:retry_active",  // STRING: repo currently being retried (empty = none)
	stack_pending: "{stack}:pending",            // LIST of taskJSON
	stack_assigned: "{stack}:assigned",          // ZSET score=unix_ts value=lang:batchIndex
	stack_assigned_tasks: "{stack}:assigned_tasks", // HASH field=lang:batchIndex value=taskJSON
	stack_done: "{stack}:done",                  // SET of lang:batchIndex
	stack_problematic: "{stack}:problematic",    // SET lang:batchIndex
	stack_problematic_tasks: "{stack}:problematic_tasks", // HASH field=lang:batchIndex value=taskJSON
	node_stats: (id: number) => `{node}:${id}:stats`,    // HASH
	heartbeat: (id: number) => `{node}:${id}:heartbeat`, // STRING con TTL
	fleet_state: "fleet:state",                  // STRING "running" | "stopped"
	fleet_phase: "fleet:phase",                  // STRING "0"|"1"|"2"|"3"
	fleet_auto_advance: "fleet:auto_advance",    // STRING "1"|"0"
	fleet_repos_enabled: "fleet:repos_enabled",  // STRING "1"|"0" — controls phase 1 (repo processing)
	fleet_stack_enabled: "fleet:stack_enabled",  // STRING "1"|"0"
	fleet_merge_enabled: "fleet:merge_enabled",  // STRING "1"|"0"
	fleet_merge_shared_fs: "fleet:merge_shared_fs",    // STRING "1"|"0"
	fleet_merge_target_node: "fleet:merge_target_node", // STRING "" | NODE_NAME
	fleet_phase_error: "fleet:phase_error",      // STRING "1" — set when auto-advance halted due to phase errors
	merge_status: "merge:status",                // STRING "idle"|"assigned"|"done" (shared-FS only)
	merge_assigned_node: "merge:assigned_node",  // STRING node_id (shared-FS only)
	merge_assigned_nodes: "merge:assigned_nodes", // SET of node_names currently running merge
	merge_ready_node_ids: "merge:ready_node_ids",  // SET of node_ids (strings) that finished saving their local dataset
	merge_done_nodes: "merge:done_nodes",        // SET of node_names that completed merge
	merge_node_samples: "merge:node_samples",    // HASH field=node_name value=sample_count
	merge_shards_loaded: "merge:shards_loaded",  // HASH field=node_name value=shards_loaded_count
	merge_shards_total: "merge:shards_total",    // HASH field=node_name value=shards_total_count
	merge_last_shard: "merge:last_shard",        // HASH field=node_name value=last_shard_name
	merge_save_pct: "merge:save_pct",            // HASH field=node_name value=save_to_disk pct (0-100)
	merge_final_merger: "merge:final_merger",    // STRING: node_name that claimed Final Merger role (SETNX)
	merge_partial_uploads: "merge:partial_uploads",   // SET: node_names that uploaded their partial zip
	merge_quit_node_names: "merge:quit_node_names",   // SET: node_names whose Merger called QUIT
	merge_final_uploaded: "merge:final_uploaded",     // STRING "1" when final_dataset.zip is ready for download
	merge_transfer: "merge:transfer",                // HASH field=node_name value=JSON {stage,bytes_done,bytes_total,peer?}
	registered_node_names: "registered:node_names",   // SET of all node_names that ever registered
	registered_node_ids: "registered:node_ids",       // SET of all node_ids (strings) that ever registered
	registered_node_hashes: "registered:node_hashes", // HASH field=node_name value=node_hash (8 ASCII chars)
	registered_node_offsets: "registered:node_offsets", // HASH field=node_name value=start_node_id
	registered_next_node_id: "registered:next_node_id", // STRING integer counter — INCRBY N on each registration
	registered_phase1_threads: "registered:phase1_threads", // HASH field=node_name value=n_threads_phase1
	registered_phase2_threads: "registered:phase2_threads", // HASH field=node_name value=n_threads_phase2
} as const;
