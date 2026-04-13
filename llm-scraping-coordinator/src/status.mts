import {redisClient as redis} from "./redis.mjs";
import {K} from "./redis-keys.mjs";

export async function getStatusData() {
	const [
		pending, assigned, done, reposProblematic, reposCancelled,
		stackPending, stackAssigned, stackDone, stackProblematicMembers,
		fleetState, fleetPhaseRaw, fleetAutoAdvanceRaw, fleetReposEnabledRaw, fleetStackEnabledRaw,
		fleetMergeEnabledRaw, fleetMergeSharedFsRaw, fleetMergeTargetNode,
		fleetPhaseErrorRaw,
		mergeStatus, mergeAssignedNode,
		mergeAssignedNodes, mergeDoneNodes, mergeNodeSamples,
		mergeShardsLoaded, mergeShardsTotal, mergeLastShard,
		mergeSavePct,
		mergeTransferRaw,
		mergeFinalUploaded,
		registeredNodeNames,
		registeredNodeOffsetsRaw,
		registeredPhase1ThreadsRaw,
		registeredPhase2ThreadsRaw,
	] = await Promise.all([
		redis.sCard(K.repos_pending),
		redis.zCard(K.repos_assigned),
		redis.sCard(K.repos_done),
		redis.sCard(K.repos_problematic),
		redis.sCard(K.repos_cancelled),
		redis.lLen(K.stack_pending),
		redis.zCard(K.stack_assigned),
		redis.sCard(K.stack_done),
		redis.sMembers(K.stack_problematic),
		redis.get(K.fleet_state),
		redis.get(K.fleet_phase),
		redis.get(K.fleet_auto_advance),
		redis.get(K.fleet_repos_enabled),
		redis.get(K.fleet_stack_enabled),
		redis.get(K.fleet_merge_enabled),
		redis.get(K.fleet_merge_shared_fs),
		redis.get(K.fleet_merge_target_node),
		redis.get(K.fleet_phase_error),
		redis.get(K.merge_status),
		redis.get(K.merge_assigned_node),
		redis.sMembers(K.merge_assigned_nodes),
		redis.sMembers(K.merge_done_nodes),
		redis.hGetAll(K.merge_node_samples),
		redis.hGetAll(K.merge_shards_loaded),
		redis.hGetAll(K.merge_shards_total),
		redis.hGetAll(K.merge_last_shard),
		redis.hGetAll(K.merge_save_pct),
		redis.hGetAll(K.merge_transfer),
		redis.get(K.merge_final_uploaded),
		redis.sMembers(K.registered_node_names),
		redis.hGetAll(K.registered_node_offsets),
		redis.hGetAll(K.registered_phase1_threads),
		redis.hGetAll(K.registered_phase2_threads),
	]);

	const registeredNodeIdsRaw = await redis.sMembers(K.registered_node_ids);
	const registeredNodeIds = registeredNodeIdsRaw.map(Number).sort((a, b) => a - b);
	const nodeStats: Record<number, Record<string, string>> = {};
	for (const id of registeredNodeIds) {
		nodeStats[id] = (await redis.hGetAll(K.node_stats(id))) ?? {};
	}

	return {
		ts: Date.now(),
		total_workers: registeredNodeIds.length,
		fleet_state: fleetState ?? "running",
		fleet_phase: parseInt(fleetPhaseRaw ?? "0"),
		fleet_auto_advance: (fleetAutoAdvanceRaw ?? "0") === "1",
		fleet_github_enabled: (fleetReposEnabledRaw ?? "1") === "1",
		fleet_stack_enabled: (fleetStackEnabledRaw ?? "1") === "1",
		fleet_merge_enabled: (fleetMergeEnabledRaw ?? "1") === "1",
		fleet_merge_shared_fs: (fleetMergeSharedFsRaw ?? "0") === "1",
		fleet_merge_target_node: fleetMergeTargetNode ?? "",
		fleet_phase_error: (fleetPhaseErrorRaw ?? "0") === "1",
		merge_final_uploaded: (mergeFinalUploaded ?? "0") === "1",
		registered_node_names: registeredNodeNames.sort(),
		registered_node_offsets: Object.fromEntries(
			Object.entries(registeredNodeOffsetsRaw ?? {}).map(([k, v]) => [k, parseInt(v)]),
		),
		registered_phase1_threads: Object.fromEntries(
			Object.entries(registeredPhase1ThreadsRaw ?? {}).map(([k, v]) => [k, parseInt(v)]),
		),
		registered_phase2_threads: Object.fromEntries(
			Object.entries(registeredPhase2ThreadsRaw ?? {}).map(([k, v]) => [k, parseInt(v)]),
		),
		merge: {
			// shared-FS fields
			status: mergeStatus ?? "idle",
			assigned_node: mergeAssignedNode != null ? parseInt(mergeAssignedNode) : null,
			// per-machine fields (no-shared-FS)
			assigned_nodes: mergeAssignedNodes.sort(),
			done_nodes: mergeDoneNodes.sort(),
			node_samples: Object.fromEntries(
				Object.entries(mergeNodeSamples ?? {}).map(([k, v]) => [k, parseInt(v)]),
			),
			// shard progress (both modes)
			shards_loaded: Object.fromEntries(
				Object.entries(mergeShardsLoaded ?? {}).map(([k, v]) => [k, parseInt(v)]),
			),
			shards_total: Object.fromEntries(
				Object.entries(mergeShardsTotal ?? {}).map(([k, v]) => [k, parseInt(v)]),
			),
			last_shard: mergeLastShard ?? {},
			save_pct: Object.fromEntries(
				Object.entries(mergeSavePct ?? {}).map(([k, v]) => [k, parseFloat(v)]),
			),
			transfer: Object.fromEntries(
				Object.entries(mergeTransferRaw ?? {}).map(([k, v]) => {
					try { return [k, JSON.parse(v)]; } catch { return [k, {stage: "unknown"}]; }
				}),
			),
		},
		github: {pending, assigned, done, problematic: reposProblematic, cancelled: reposCancelled},
		stack: {
			total_batches: stackPending + stackAssigned + stackDone + stackProblematicMembers.length,
			pending: stackPending,
			assigned: stackAssigned,
			done: stackDone,
			problematic: stackProblematicMembers.length,
			problematic_list: stackProblematicMembers.sort(),
		},
		nodes: nodeStats,
	};
}

export async function getRedisData() {
	const now = Date.now();
	const nowSec = now / 1000;

	const [
		reposPendingCount, reposAssignedCount, reposDoneCount, reposCancelledCount,
		stackPendingCount, stackDoneCount,
	] = await Promise.all([
		redis.sCard(K.repos_pending),
		redis.zCard(K.repos_assigned),
		redis.sCard(K.repos_done),
		redis.sCard(K.repos_cancelled),
		redis.lLen(K.stack_pending),
		redis.sCard(K.stack_done),
	]);

	const [
		stackAssignedEntries,
		stackDoneMembers,
		stackProblematicMembers,
	] = await Promise.all([
		redis.zRangeWithScores(K.stack_assigned, 0, -1),
		redis.sMembers(K.stack_done),
		redis.sMembers(K.stack_problematic),
	]);

	const stackAssignedTasks: Record<string, any> = {};
	for (const entry of stackAssignedEntries) {
		const raw = await redis.hGet(K.stack_assigned_tasks, entry.value);
		stackAssignedTasks[entry.value] = raw ? JSON.parse(raw) : null;
	}

	const stackProblematicTasks: Record<string, any> = {};
	for (const key of stackProblematicMembers) {
		const raw = await redis.hGet(K.stack_problematic_tasks, key);
		stackProblematicTasks[key] = raw ? JSON.parse(raw) : null;
	}

	const [
		reposAssignedEntries,
		reposPendingMembers,
		reposCancelledSample,
		stackPendingSample,
	] = await Promise.all([
		redis.zRangeWithScores(K.repos_assigned, 0, -1),
		redis.sMembers(K.repos_pending),
		redis.sRandMemberCount(K.repos_cancelled, 50),
		redis.lRange(K.stack_pending, 0, -1),
	]);

	const registeredNodeIdsRaw = await redis.sMembers(K.registered_node_ids);
	const registeredNodeIds = registeredNodeIdsRaw.map(Number).sort((a, b) => a - b);
	const nodes: Record<number, {stats: Record<string, string>; heartbeatTtl: number}> = {};
	for (const id of registeredNodeIds) {
		const [stats, ttl] = await Promise.all([
			redis.hGetAll(K.node_stats(id)),
			redis.ttl(K.heartbeat(id)),
		]);
		nodes[id] = {stats: stats ?? {}, heartbeatTtl: ttl};
	}

	return {
		ts: now,
		total_workers: registeredNodeIds.length,
		keys: {
			repos_pending: {count: reposPendingCount, members: reposPendingMembers},
			repos_assigned: {
				count: reposAssignedCount,
				entries: reposAssignedEntries.map((e: {value: string; score: number}) => ({
					repo: e.value,
					assignedAt: e.score,
					ageMin: Math.round((nowSec - e.score) / 60),
				})),
			},
			repos_done: {count: reposDoneCount},
			repos_cancelled: {count: reposCancelledCount, sample: reposCancelledSample},
			stack_pending: {
				count: stackPendingCount,
				sample: stackPendingSample.map((s: string) => {
					try { return JSON.parse(s); } catch { return s; }
				}),
			},
			stack_assigned: {
				count: stackAssignedEntries.length,
				entries: stackAssignedEntries.map((e: {value: string; score: number}) => ({
					key: e.value,
					assignedAt: e.score,
					ageMin: Math.round((nowSec - e.score) / 60),
					task: stackAssignedTasks[e.value],
				})),
			},
			stack_done: {count: stackDoneCount, members: stackDoneMembers.sort()},
			stack_problematic: {
				count: stackProblematicMembers.length,
				entries: stackProblematicMembers.map((k: string) => ({key: k, task: stackProblematicTasks[k]})),
			},
		},
		nodes,
	};
}
