function toggleCollapseOnly(event) {
	event.stopPropagation();
	const item = event.currentTarget.closest('.progress-item');
	if (!item.classList.contains('progress-item--disabled')) {
		item.classList.toggle('progress-item--collapsed');
	}
}

function togglePhase(headerEl) {
	const item = headerEl.closest('.progress-item');
	const isDisabled = item.classList.contains('progress-item--disabled');
	if (!isDisabled) {
		item.classList.toggle('progress-item--collapsed');
	}

	if (_fleetState === 'stopped' && !isDisabled) {
		const match = item.id.match(/phase(\d+)$/);
		if (match) {
			_selectedPhase = parseInt(match[1]);
			updatePhaseBtn(_fleetState, _fleetPhase);
			updatePhaseSelectionStyles();
		}
	}
}


let prevData = null;
let _nodeOffsets = {};       // node_name → start_node_id
let _phase1Threads = {};     // node_name → n_threads_phase1
let _phase2Threads = {};     // node_name → n_threads_phase2
const logEl = document.getElementById('log');
const MAX_LOG = 60;

function isWorkerActiveInPhase(nodeId, nodeName, phase) {
	const startId = _nodeOffsets[nodeName] ?? null;
	if (startId === null) return true; // no registration data yet — assume active
	if (phase === 1) {
		const n1 = _phase1Threads[nodeName] ?? null;
		return n1 !== null ? nodeId < startId + n1 : true;
	}
	if (phase === 2) {
		const n2 = _phase2Threads[nodeName] ?? null;
		return n2 !== null ? nodeId < startId + n2 : true;
	}
	if (phase === 3) return nodeId === startId; // only the first node per machine runs merge
	return true;
}

function fmt(n) {
	if (n == null || n === '') return '—';
	return Number(n).toLocaleString();
}

function pct(a, total) {
	if (!total) return 0;
	return Math.round((a / total) * 100);
}

function ts() {
	return new Date().toTimeString().slice(0, 8);
}

function addLog(msg, tag) {
	const line = document.createElement('div');
	line.className = 'log-line';
	line.innerHTML = `<span class="ts">${ts()}</span><span class="tag-${tag ?? 'green'}">${msg}</span>`;
	logEl.prepend(line);
	while (logEl.children.length > MAX_LOG) logEl.removeChild(logEl.lastChild);
}

function flash(id) {
	const el = document.getElementById(id);
	if (!el) return;
	el.classList.remove('flash');
	void el.offsetWidth;
	el.classList.add('flash');
}

function setText(id, val) {
	const el = document.getElementById(id);
	if (el && el.textContent !== val) el.textContent = val;
}

function setWidth(id, pct) {
	const el = document.getElementById(id);
	if (el) el.style.width = pct + '%';
}

function pctColor(p) {
	const t = Math.min(Math.max(p, 0), 100) / 100;
	const r = Math.round(0x55 + t * (0x2d - 0x55));
	const g = Math.round(0x55 + t * (0xd4 - 0x55));
	const b = Math.round(0x55 + t * (0xbf - 0x55));
	return `rgb(${r},${g},${b})`;
}

function setPctEl(id, value, total) {
	const el = document.getElementById(id);
	if (!el) return;
	if (!total) { el.textContent = ''; return; }
	const p = Math.round(value / total * 100);
	el.textContent = p + '%';
	el.style.color = pctColor(p);
}

function update(data) {
	const github = data.github;
	const stack = data.stack;
	const nodes = data.nodes;

	const reposTotal = github.done + github.assigned + github.pending + (github.problematic || 0) + (github.cancelled || 0);
	const stackTotal = stack.done + (stack.assigned || 0) + stack.pending + (stack.problematic || 0);
	const totalSamples = Object.values(nodes).reduce((acc, n) => acc + (parseInt(n.samples_collected) || 0), 0);
	const now = Date.now();
	const activeWorkers = Object.values(nodes).filter(n => {
		const lastHb = parseInt(n.last_heartbeat) || 0;
		const alive = lastHb > 0 && (now - lastHb) < 2 * 60 * 1000;
		return alive && ((n.current_repo && n.current_repo !== '') || !!n.current_stack);
	}).length;

	// Metrics
	setText('m-samples', fmt(totalSamples));
	setText('m-repos-done', fmt(github.done));
	setText('m-repos-sub', `of ${fmt(reposTotal)} total (${fmt(github.cancelled || 0)} cancelled)`);
	setText('m-stack', fmt(stack.pending));
	setText('m-stack-sub', `of ${fmt(stackTotal)} total`);
	setText('m-active', fmt(activeWorkers));
	setText('m-active-sub', `of ${fmt(data.total_workers)} total`);

	// Progress bars - repos (phase 1)
	const rTot = reposTotal || 1;
	setText('p2-done', fmt(github.done));
	setText('p2-active', fmt(github.assigned));
	setText('p2-pending', fmt(github.pending));
	setText('p2-problematic', fmt(github.problematic || 0));
	setText('p2-cancelled', fmt(github.cancelled || 0));
	setWidth('bar-repos-done', pct(github.done, rTot));
	setWidth('bar-repos-active', pct(github.assigned, rTot));
	setWidth('bar-repos-pending', pct(github.pending, rTot));
	setPctEl('p2-pct', github.done, reposTotal);

	// Progress bars - stack
	const sTot = stackTotal || 1;
	setText('p-s-done', fmt(stack.done));
	setText('p-s-assigned', fmt(stack.assigned || 0));
	setText('p-s-pending', fmt(stack.pending));
	setText('p-s-problematic', fmt(stack.problematic || 0));
	setWidth('bar-s-done', pct(stack.done, sTot));
	setWidth('bar-s-assigned', pct(stack.assigned || 0, sTot));
	setWidth('bar-s-pending', pct(stack.pending, sTot));
	setWidth('bar-s-problematic', pct(stack.problematic || 0, sTot));
	setPctEl('p-s-queue-pct', stack.done, stackTotal);

	const totalStackScanned = Object.values(nodes).reduce((acc, n) => acc + (parseInt(n.stack_scanned) || 0), 0);
	const totalStackSamples = Object.values(nodes).reduce((acc, n) => acc + (parseInt(n.stack_samples_done) || 0) + (parseInt(n.stack_samples) || 0), 0);
	setText('p-s-scanned', fmt(totalStackScanned));
	setText('p-s-stack-samples', fmt(totalStackSamples));
	setText('m-stack-scanned', fmt(totalStackScanned));
	setText('m-stack-samples', fmt(totalStackSamples));

	// Phase 4 merge status
	if (data.merge) {
		const m = data.merge;
		const sharedFs = data.fleet_merge_shared_fs ?? _mergeSharedFs;

		const sharedDisplay = document.getElementById('merge-shared-display');
		const machinesDisplay = document.getElementById('merge-machines-display');
		if (sharedDisplay) sharedDisplay.style.display = sharedFs ? '' : 'none';
		if (machinesDisplay) machinesDisplay.style.display = sharedFs ? 'none' : '';

		if (sharedFs) {
			const statusEl = document.getElementById('p-merge-status');
			const nodeEl = document.getElementById('p-merge-node');
			const barDone = document.getElementById('bar-merge-done');
			const barActive = document.getElementById('bar-merge-active');
			if (statusEl) {
				if (m.status === 'done') {
					statusEl.textContent = '✓ done';
					statusEl.style.color = 'var(--green)';
					if (barDone) barDone.style.width = '100%';
					if (barActive) barActive.style.width = '0%';
				} else if (m.status === 'assigned') {
					statusEl.textContent = '⟳ running';
					statusEl.style.color = 'var(--teal)';
					if (barDone) barDone.style.width = '0%';
					if (barActive) barActive.style.width = '100%';
				} else {
					statusEl.textContent = 'idle';
					statusEl.style.color = 'var(--text3)';
					if (barDone) barDone.style.width = '0%';
					if (barActive) barActive.style.width = '0%';
				}
			}
			if (nodeEl) nodeEl.textContent = m.assigned_node != null ? `worker-${String(m.assigned_node).padStart(2, '0')}` : '';
		} else {
			// Per-machine display
			const machinesList = document.getElementById('merge-machines-list');
			if (machinesList && data.registered_node_names) {
				const assignedSet = new Set(m.assigned_nodes ?? []);
				const doneSet = new Set(m.done_nodes ?? []);
				const samples = m.node_samples ?? {};
				const shardsLoaded = m.shards_loaded ?? {};
				const shardsTotal = m.shards_total ?? {};
				const targetNode = data.fleet_merge_target_node ?? _mergeTargetNode;
				const machines = targetNode ? [targetNode] : data.registered_node_names;
				machinesList.innerHTML = machines.map(name => {
					let icon, color;
					if (doneSet.has(name)) {
						icon = '✓'; color = 'var(--green)';
					} else if (assignedSet.has(name)) {
						icon = '⟳'; color = 'var(--teal)';
					} else {
						icon = '—'; color = 'var(--text3)';
					}
					const sampleStr = samples[name] != null ? ` <span style="color:var(--text3)">(${fmt(samples[name])})</span>` : '';
					const sl = shardsLoaded[name] ?? null;
					const st = shardsTotal[name] ?? null;
					const shardStr = sl != null && st != null
						? ` <span style="color:var(--text3)">[${sl}/${st} shards]</span>`
						: '';
					return `<div><span style="color:${color};width:12px;display:inline-block">${icon}</span> <span style="color:var(--text2)">${name}</span>${sampleStr}${shardStr}</div>`;
				}).join('');
			}
		}

		// Shards loading bar (always rendered)
		const shardsLoadedVals = Object.values(m.shards_loaded ?? {});
		const shardsTotalVals = Object.values(m.shards_total ?? {});
		const totalShardsLoaded = shardsLoadedVals.reduce((a, v) => a + v, 0);
		const totalShardsTotal = shardsTotalVals.reduce((a, v) => a + v, 0);
		setText('p-merge-shards-loaded', String(totalShardsLoaded));
		setText('p-merge-shards-total', totalShardsTotal > 0 ? String(totalShardsTotal) : '?');
		setWidth('bar-merge-shards', totalShardsTotal > 0 ? pct(totalShardsLoaded, totalShardsTotal) : 0);

		// Machines merged bar (always rendered)
		const totalMachines = (data.registered_node_names ?? []).length;
		const doneMachines = (m.done_nodes ?? []).length;
		setText('p-merge-machines-done', String(doneMachines));
		setText('p-merge-machines-total', totalMachines > 0 ? String(totalMachines) : '?');
		setWidth('bar-merge-machines', totalMachines > 0 ? pct(doneMachines, totalMachines) : 0);

		// Dataset save_to_disk progress bar
		const savePctVals = Object.values(m.save_pct ?? {});
		const avgSavePct = savePctVals.length > 0
			? savePctVals.reduce((a, v) => a + v, 0) / savePctVals.length
			: 0;
		setText('p-merge-save-pct', avgSavePct.toFixed(1));
		setWidth('bar-merge-save', avgSavePct);

		// Post-merge transfer progress
		const transfer = m.transfer ?? {};
		const transferSection = document.getElementById('merge-transfer-section');
		const transferList = document.getElementById('merge-transfer-list');
		const hasTransfer = Object.keys(transfer).length > 0;
		if (transferSection) transferSection.style.display = hasTransfer ? '' : 'none';
		if (transferList && hasTransfer) {
			const machines = data.registered_node_names ?? Object.keys(transfer);
			transferList.innerHTML = machines.map(name => {
				const t = transfer[name] ?? null;
				if (!t) return '';
				const stage = t.stage ?? '';
				const bytesDone = t.bytes_done ?? 0;
				const bytesTotal = t.bytes_total ?? 0;
				const peer = t.peer ?? '';
				const peerTag = peer ? ` <span style="color:var(--text3)">← ${peer}</span>` : '';
				if (stage === 'uploading_partial' || stage === 'uploading_final' || stage === 'downloading_partial') {
					const pct = bytesTotal > 0 ? Math.min(100, Math.round(bytesDone * 100 / bytesTotal)) : 0;
					const gbDone = (bytesDone / 1e9).toFixed(1);
					const gbTotal = bytesTotal > 0 ? (bytesTotal / 1e9).toFixed(1) : '?';
					const stageLabel = stage === 'uploading_partial' ? 'uploading partial' :
						stage === 'uploading_final' ? 'uploading final' :
						`downloading${peer ? ' ' + peer : ''}`;
					return `<div>
						<div style="display:flex;justify-content:space-between;margin-bottom:3px">
							<span style="color:var(--text2)">${name}</span>
							<span style="color:var(--teal)">${stageLabel} — ${pct}%</span>
						</div>
						<div class="bar-track" style="height:4px">
							<div class="bar-fill bar-active" style="width:${pct}%"></div>
						</div>
						<div style="color:var(--text3);margin-top:3px;font-size:10px">${gbDone} / ${gbTotal} GB</div>
					</div>`;
				} else if (stage === 'zipping') {
					return `<div><span style="color:var(--text2)">${name}</span><span style="color:var(--text3)"> compressing dataset…</span></div>`;
				} else if (stage === 'extracting') {
					return `<div><span style="color:var(--text2)">${name}</span><span style="color:var(--text3)"> extracting</span>${peerTag}</div>`;
				} else if (stage === 'integrating') {
					return `<div><span style="color:var(--text2)">${name}</span><span style="color:var(--text3)"> integrating</span>${peerTag}</div>`;
				} else if (stage === 'shuffling') {
					return `<div><span style="color:var(--text2)">${name}</span><span style="color:var(--teal)"> ⟳ final global shuffle…</span></div>`;
				} else if (stage === 'waiting_partials') {
					return `<div><span style="color:var(--text2)">${name}</span><span style="color:var(--text3)"> waiting for other machines…</span></div>`;
				}
				return '';
			}).filter(Boolean).join('');
		}
	}

	// Problematic stack tasks
	const problematicSection = document.getElementById('problematic-section');
	const problematicList = document.getElementById('problematic-list');
	const pList = stack.problematic_list ?? [];
	if (pList.length > 0) {
		problematicSection.style.display = '';
		problematicList.innerHTML = pList.map(key => {
			const [lang, nodeId] = key.split(':');
			return `<div><span style="color:var(--red)">✕</span> <span style="color:var(--text2)">${lang}</span><span style="color:var(--text3)">  ·  worker-${String(nodeId).padStart(2,'0')}</span></div>`;
		}).join('');
	} else {
		problematicSection.style.display = 'none';
	}

	// Workers grid — registered workers only (node_name set by /worker/register)
	const grid = document.getElementById('workers-grid');
	const registeredIds = Object.keys(nodes).map(Number).filter(i => nodes[i]?.node_name).sort((a, b) => a - b);
	Array.from(grid.querySelectorAll('.worker-card')).forEach(card => {
		const id = parseInt(card.id.replace('wcard-', ''));
		if (!registeredIds.includes(id)) card.remove();
	});
	for (const i of registeredIds) {
		const n = nodes[i] ?? {};
		let card = document.getElementById(`wcard-${i}`);
		if (!card) {
			card = document.createElement('div');
			card.className = 'worker-card';
			card.id = `wcard-${i}`;
			grid.appendChild(card);
		}

		const lastHb = parseInt(n.last_heartbeat) || 0;
		const msAgo = now - lastHb;
		const isAlive  = lastHb > 0 && msAgo < 2 * 60 * 1000;
		const isBusy   = lastHb > 0 && msAgo >= 2 * 60 * 1000 && msAgo < 20 * 60 * 1000;
		const isDead   = lastHb > 0 && msAgo >= 20 * 60 * 1000;
		const neverSeen = !lastHb;

		const repo = n.current_repo || '';
		const repoShort = repo ? repo.split('/').pop() : null;
		const hasCurrentStack = !!n.current_stack;
		const stackScanned = parseInt(n.stack_scanned) || 0;
		const stackSamplesLive = parseInt(n.stack_samples) || 0;
		const stackSamplesDone = parseInt(n.stack_samples_done) || 0;
		const stackFinished = !hasCurrentStack && (stackScanned > 0 || stackSamplesLive > 0);
		const hasActiveWork = !!repo || hasCurrentStack;
		const lastEnabledPhase = _mergeEnabled ? 3 : _stackEnabled ? 2 : _githubEnabled ? 1 : 0;
		const allPhasesComplete = _fleetPhase > lastEnabledPhase;
		const isWorkerDone = isAlive && !hasActiveWork && allPhasesComplete;
		const isWorkerIdle = isAlive && !hasActiveWork && !allPhasesComplete;

		const reposDone = parseInt(n.repos_done) || 0;

		let phase1Class = 'phase-pill', phase1Label = '— repos';
		if (repo) {
			phase1Class += ' phase-running'; phase1Label = '⟳ cloning';
		} else if (reposDone > 0) {
			phase1Class += ' phase-done'; phase1Label = `✓ repos (${reposDone})`;
		} else if (!_githubEnabled) {
			phase1Class += ' phase-disabled'; phase1Label = '— repos';
		}

		let phase2Class = 'phase-pill', phase2Label = '— stack';
		if (hasCurrentStack) {
			phase2Class += ' phase-running'; phase2Label = `⟳ ${n.current_stack}`;
		} else if (stackSamplesDone > 0 || stackFinished) {
			phase2Class += ' phase-done'; phase2Label = `✓ stack`;
		} else if (!_stackEnabled) {
			phase2Class += ' phase-disabled'; phase2Label = '— stack';
		}

		const nodeName = n.node_name || '';
		let isDisabledForPhase;
		if (_fleetPhase > 0 && _fleetState === 'running') {
			isDisabledForPhase = !isWorkerActiveInPhase(i, nodeName, _fleetPhase);
		} else {
			isDisabledForPhase = !(
				(_githubEnabled && isWorkerActiveInPhase(i, nodeName, 1)) ||
				(_stackEnabled  && isWorkerActiveInPhase(i, nodeName, 2)) ||
				(_mergeEnabled  && isWorkerActiveInPhase(i, nodeName, 3))
			);
		}
		card.className = 'worker-card' + (isDisabledForPhase || neverSeen ? ' worker-disabled' : isDead ? ' worker-dead' : isBusy ? ' worker-busy' : (isWorkerIdle || isWorkerDone) ? ' worker-idle' : '');

		const displayName = nodeName;
		let statusBadge;
		if (isDisabledForPhase || neverSeen) {
			statusBadge = `<span class="worker-badge badge-disabled">DISABLED</span>`;
		} else if (isDead) {
			const minAgo = Math.round(msAgo / 60000);
			statusBadge = `<span class="worker-badge badge-dead">DEAD ${minAgo}m</span>`;
		} else if (isBusy) {
			const minAgo = Math.round(msAgo / 60000);
			statusBadge = `<span class="worker-badge badge-busy">BUSY ${minAgo}m</span>`;
		} else if (isWorkerDone) {
			statusBadge = `<span class="worker-badge badge-done">DONE</span>`;
		} else if (isWorkerIdle) {
			statusBadge = `<span class="worker-badge badge-idle">IDLE</span>`;
		} else {
			statusBadge = `<span class="worker-badge badge-run">RUN</span>`;
		}

		const stackTotal2 = parseInt(n.stack_total) || 0;
		const stackPct = stackTotal2 > 0 ? (stackScanned / stackTotal2 * 100).toFixed(1) : '??';

		let stackLine = '';
		if (hasCurrentStack) {
			const ofTotal = stackTotal2 > 0 ? ` of ${fmt(stackTotal2)}` : '';
			const pctStr = ` <span style="color:var(--text3)">(${stackPct}%${ofTotal})</span>`;
			stackLine = `<div class="worker-repo" style="margin-top:6px;white-space:normal">` +
				`<span class="stack-spin">⟳</span> stack: <span style="color:var(--amber)">${n.current_stack}</span>` +
				` — ${fmt(stackScanned)} scanned${pctStr}` +
				`<span class="stack-bullet">•</span>${fmt(stackSamplesLive)} collected</div>`;
		} else if (stackFinished) {
			stackLine = `<div class="worker-repo" style="margin-top:6px;white-space:normal;color:var(--text3)">` +
				`scanned: ${fmt(stackScanned)}<br>` +
				`collected: ${fmt(stackSamplesLive)}</div>`;
		}

		card.innerHTML = `
      <div class="worker-id">
        <span>${displayName ? `${displayName} <span style="color:var(--text3)">(worker-${String(i).padStart(2, '00')})</span>` : `worker-${String(i).padStart(2, '00')}`}</span>
        ${statusBadge}
      </div>
      <div class="phases">
        <span class="${phase1Class}">${phase1Label}</span>
        <span class="${phase2Class}">${phase2Label}</span>
      </div>
      <div class="worker-stat">
        <span class="worker-stat-label">samples</span>
        <span class="worker-stat-value">${fmt(n.samples_collected) ?? '0'}</span>
      </div>
      <div class="worker-stat">
        <span class="worker-stat-label">failed</span>
        <span class="worker-stat-value" style="color:${parseInt(n.repos_failed) > 0 ? 'var(--red)' : 'var(--text3)'}">${n.repos_failed ?? '0'}</span>
      </div>
      ${stackSamplesDone > 0 ? `
      <div class="worker-stat">
        <span class="worker-stat-label">stack done</span>
        <span class="worker-stat-value" style="color:var(--teal)">${fmt(stackSamplesDone)}</span>
      </div>` : ''}
      ${repoShort ? `<div class="worker-repo">→ <span>${repoShort}</span></div>` : ''}
      ${isWorkerDone ? `<div class="worker-repo" style="margin-top:6px;font-style:italic">work finished</div>` : ''}
      ${stackLine}
    `;
	}

	// Detect changes for activity log
	if (prevData) {
		const dDone = github.done - prevData.github.done;
		if (dDone > 0) addLog(`+${dDone} repo completed`, 'green');
		const dSamples = totalSamples - Object.values(prevData.nodes).reduce((a, n) => a + (parseInt(n.samples_collected) || 0), 0);
		if (dSamples > 1000) addLog(`+${fmt(dSamples)} new samples collected`, 'blue');
		if (stack.done > prevData.stack.done) addLog(`stack task completed`, 'teal');
		const dProblematic = (stack.problematic || 0) - (prevData.stack.problematic || 0);
		if (dProblematic > 0) addLog(`${dProblematic} stack task(s) timed out → problematic`, 'red');
		if (data.merge && prevData.merge) {
			const prevLoaded = Object.values(prevData.merge.shards_loaded ?? {}).reduce((a, v) => a + v, 0);
			const currLoaded = Object.values(data.merge.shards_loaded ?? {}).reduce((a, v) => a + v, 0);
			if (currLoaded > prevLoaded) {
				const lastName = Object.values(data.merge.last_shard ?? {}).find(v => v) ?? '';
				addLog(`local shard loaded${lastName ? ' — ' + lastName : ''}`, 'teal');
			}
			const prevMachinesDone = (prevData.merge.done_nodes ?? []).length;
			const currMachinesDone = (data.merge.done_nodes ?? []).length;
			const totalMach = (data.registered_node_names ?? []).length;
			if (currMachinesDone > prevMachinesDone) {
				addLog(`machine merged ${currMachinesDone}/${totalMach}`, 'green');
			}
			const prevSavePctVals = Object.values(prevData.merge.save_pct ?? {});
			const prevAvgSave = prevSavePctVals.length > 0
				? prevSavePctVals.reduce((a, v) => a + v, 0) / prevSavePctVals.length : 0;
			const savePctVals2 = Object.values(data.merge.save_pct ?? {});
			const currAvgSave = savePctVals2.length > 0
				? savePctVals2.reduce((a, v) => a + v, 0) / savePctVals2.length : 0;
			if (Math.floor(currAvgSave / 10) > Math.floor(prevAvgSave / 10) && currAvgSave > 0) {
				addLog(`dataset save: ${currAvgSave.toFixed(1)}%`, 'teal');
			}
			// Transfer stage changes
			const prevTransfer = prevData.merge.transfer ?? {};
			const currTransfer = data.merge.transfer ?? {};
			for (const [name, curr] of Object.entries(currTransfer)) {
				const prev = prevTransfer[name] ?? null;
				const prevStage = prev ? prev.stage : null;
				const stage = curr.stage ?? '';
				if (prevStage !== stage) {
					const gb = curr.bytes_total > 0 ? ` (${(curr.bytes_total / 1e9).toFixed(1)} GB)` : '';
					const peer = curr.peer ? ` ${curr.peer}` : '';
					if (stage === 'zipping') addLog(`${name}: compressing dataset`, 'teal');
					else if (stage === 'uploading_partial') addLog(`${name}: uploading partial${gb}`, 'teal');
					else if (stage === 'uploading_final') addLog(`${name}: uploading final dataset${gb}`, 'teal');
					else if (stage === 'waiting_partials') addLog(`${name}: waiting for other machines`, 'teal');
					else if (stage === 'downloading_partial') addLog(`${name}: downloading partial from${peer}${gb}`, 'teal');
					else if (stage === 'extracting') addLog(`${name}: extracting${peer}`, 'teal');
					else if (stage === 'integrating') addLog(`${name}: integrating${peer}`, 'teal');
					else if (stage === 'shuffling') addLog(`${name}: final global shuffle`, 'teal');
				} else if (stage === 'uploading_partial' || stage === 'uploading_final' || stage === 'downloading_partial') {
					// Log at 25 / 50 / 75% milestones
					const bTotal = curr.bytes_total ?? 0;
					const bPrev = prev ? (prev.bytes_done ?? 0) : 0;
					const bCurr = curr.bytes_done ?? 0;
					if (bTotal > 0) {
						const prevMilestone = Math.floor(bPrev * 4 / bTotal);
						const currMilestone = Math.floor(bCurr * 4 / bTotal);
						if (currMilestone > prevMilestone && currMilestone >= 1 && currMilestone <= 3) {
							const pct = currMilestone * 25;
							const label = stage === 'downloading_partial' ? `download ${curr.peer ?? '?'}` : stage.replace('_', ' ');
							addLog(`${name}: ${label} ${pct}%`, 'teal');
						}
					}
				}
			}
		}
	}

	prevData = JSON.parse(JSON.stringify(data));

	document.getElementById('last-update').textContent = new Date(data.ts).toTimeString().slice(0, 8);
}

// Phase control
let _fleetState = 'stopped';
let _fleetPhase = 0;
let _phaseError = false;
let _githubEnabled = true;
let _stackEnabled = true;
let _mergeEnabled = true;
let _mergeSharedFs = false;
let _mergeTargetNode = '';
let _reposPhaseDone = false;
let _stackPhaseDone = false;
let _mergePhaseDone = false;
let _reposProblematic = 0;
let _stackProblematic = 0;
let _selectedPhase = null;
let _mergeFinalUploaded = false;

function updatePhaseBtn(state, phase) {
	const btn = document.getElementById('phase-btn');
	if (!btn) return;
	if (state === 'running') {
		btn.disabled = false;
		btn.textContent = `⏸ stop phase ${phase}`;
		btn.style.background = 'var(--red-dim)';
		btn.style.color = 'var(--red)';
		btn.style.borderColor = '#7f1d1d';
	} else if (state === 'stopped' && _phaseError && phase === 1 && _reposProblematic > 0) {
		btn.disabled = false;
		btn.textContent = `⟳ retry problematic (${_reposProblematic})`;
		btn.style.background = 'var(--amber-dim)';
		btn.style.color = 'var(--amber)';
		btn.style.borderColor = '#78350f';
	} else if (state === 'stopped' && _phaseError && _stackProblematic > 0) {
		btn.disabled = false;
		btn.textContent = `⟳ retry stack problematic (${_stackProblematic})`;
		btn.style.background = 'var(--amber-dim)';
		btn.style.color = 'var(--amber)';
		btn.style.borderColor = '#78350f';
	} else if (phase >= 4) {
		btn.textContent = '✓ all phases complete';
		btn.style.background = 'var(--green-dim)';
		btn.style.color = 'var(--green)';
		btn.style.borderColor = '#166534';
		btn.disabled = true;
	} else {
		if (!_githubEnabled && !_stackEnabled && !_mergeEnabled) {
			btn.textContent = '⚠ enable at least 1 phase';
			btn.style.background = 'var(--amber-dim)';
			btn.style.color = 'var(--amber)';
			btn.style.borderColor = '#78350f';
			btn.disabled = true;
			return;
		}
		btn.disabled = false;
		const currentPhaseEnabled = (phase === 1 && _githubEnabled) || (phase === 2 && _stackEnabled) || (phase === 3 && _mergeEnabled);
		if (phase > 0 && _selectedPhase === null && !currentPhaseEnabled) {
			btn.textContent = 'select a phase to run';
			btn.style.background = 'var(--bg2)';
			btn.style.color = 'var(--text3)';
			btn.style.borderColor = 'var(--border)';
			btn.disabled = true;
			return;
		}
		let label;
		if (_selectedPhase !== null) label = _selectedPhase;
		else if (phase === 0) label = _githubEnabled ? 1 : _stackEnabled ? 2 : 3;
		else label = phase;
		btn.textContent = `▶ start phase ${label}`;
		btn.style.background = 'var(--green-dim)';
		btn.style.color = 'var(--green)';
		btn.style.borderColor = '#166534';
	}
}

function updatePhaseSelectionStyles() {
	[1, 2, 3].forEach(n => {
		const el = document.getElementById(`progress-item-phase${n}`);
		if (el) el.classList.toggle('progress-item--selected', _selectedPhase === n);
	});
}

async function handlePhaseBtn() {
	try {
		if (_fleetState === 'running') {
			const res = await fetch('/fleet/phase/stop', {method: 'POST'});
			const data = await res.json();
			_fleetState = data.state;
			_fleetPhase = data.phase;
			addLog(`phase ${data.phase} stopped`, 'red');
		} else if (_phaseError && _fleetPhase === 1 && _reposProblematic > 0) {
			// RETRY PROBLEMATIC: re-queue failed repos, reset counters, restart phase 1
			await fetch('/reset/repos_problematic', {method: 'POST'});
			_reposProblematic = 0;
			const res = await fetch('/fleet/phase/start', {method: 'POST'});
			const data = await res.json();
			_fleetState = data.state;
			_fleetPhase = data.phase;
			_phaseError = false;
			const banner = document.getElementById('phase-error-banner');
			if (banner) banner.style.display = 'none';
			_selectedPhase = null;
			addLog(`retrying phase 1 — problematic repos re-queued`, 'amber');
		} else if (_phaseError && _stackProblematic > 0) {
			// RETRY STACK PROBLEMATIC: re-queue timed-out stack tasks, set phase back to 2, restart
			const count = _stackProblematic;
			await fetch('/reset/problematic', {method: 'POST'});
			_stackProblematic = 0;
			await fetch('/fleet/phase/set', {
				method: 'POST',
				headers: {'Content-Type': 'application/json'},
				body: JSON.stringify({phase: 2}),
			});
			const res2 = await fetch('/fleet/phase/start', {method: 'POST'});
			const data2 = await res2.json();
			_fleetState = data2.state;
			_fleetPhase = data2.phase;
			_phaseError = false;
			const banner = document.getElementById('phase-error-banner');
			if (banner) banner.style.display = 'none';
			_selectedPhase = null;
			addLog(`retrying phase 2 — ${count} problematic stack tasks re-queued`, 'amber');
		} else {
			if (_selectedPhase !== null && _selectedPhase !== _fleetPhase) {
				await fetch('/fleet/phase/set', {
					method: 'POST',
					headers: {'Content-Type': 'application/json'},
					body: JSON.stringify({phase: _selectedPhase}),
				});
			}
			const res = await fetch('/fleet/phase/start', {method: 'POST'});
			const data = await res.json();
			_fleetState = data.state;
			_fleetPhase = data.phase;
			_selectedPhase = null;
			addLog(`phase ${data.phase} started`, 'green');
		}
		updatePhaseBtn(_fleetState, _fleetPhase);
		updatePhaseSelectionStyles();
	} catch (e) {
		addLog('phase control failed: ' + e.message, 'red');
	}
}

async function setAutoAdvance(enabled) {
	try {
		await fetch('/fleet/auto_advance', {
			method: 'POST',
			headers: {'Content-Type': 'application/json'},
			body: JSON.stringify({enabled}),
		});
		addLog(`auto-advance ${enabled ? 'on' : 'off'}`, enabled ? 'green' : 'red');
	} catch (e) {
		addLog('auto-advance update failed: ' + e.message, 'red');
	}
}

async function setGithubEnabled(enabled) {
	_githubEnabled = enabled;
	if (!enabled && _selectedPhase === 1) _selectedPhase = null;
	applyPhaseEnableStyles();
	updatePhaseSelectionStyles();
	updatePhaseBtn(_fleetState, _fleetPhase);
	if (prevData) _origUpdate(prevData);
	try {
		await fetch('/fleet/github_enabled', {
			method: 'POST',
			headers: {'Content-Type': 'application/json'},
			body: JSON.stringify({enabled}),
		});
		addLog(`phase 1 ${enabled ? 'enabled' : 'disabled'}`, enabled ? 'green' : 'red');
	} catch (e) {
		addLog('phase 1 update failed: ' + e.message, 'red');
	}
}

async function setStackEnabled(enabled) {
	_stackEnabled = enabled;
	if (!enabled && _selectedPhase === 2) _selectedPhase = null;
	applyPhaseEnableStyles();
	updatePhaseSelectionStyles();
	updatePhaseBtn(_fleetState, _fleetPhase);
	if (prevData) _origUpdate(prevData);
	try {
		await fetch('/fleet/stack_enabled', {
			method: 'POST',
			headers: {'Content-Type': 'application/json'},
			body: JSON.stringify({enabled}),
		});
		addLog(`phase 2 ${enabled ? 'enabled' : 'disabled'}`, enabled ? 'green' : 'red');
	} catch (e) {
		addLog('phase 2 update failed: ' + e.message, 'red');
	}
}

async function setMergeEnabled(enabled) {
	_mergeEnabled = enabled;
	const mergeSection = document.getElementById('merge-model-section');
	if (mergeSection) mergeSection.style.display = enabled ? '' : 'none';
	if (!enabled && _selectedPhase === 3) _selectedPhase = null;
	applyPhaseEnableStyles();
	updatePhaseSelectionStyles();
	updatePhaseBtn(_fleetState, _fleetPhase);
	try {
		await fetch('/fleet/merge_enabled', {
			method: 'POST',
			headers: {'Content-Type': 'application/json'},
			body: JSON.stringify({enabled}),
		});
		addLog(`phase 3 ${enabled ? 'enabled' : 'disabled'}`, enabled ? 'green' : 'red');
	} catch (e) {
		addLog('phase 3 update failed: ' + e.message, 'red');
	}
}

async function setMergeSharedFs(enabled) {
	_mergeSharedFs = enabled;
	try {
		await fetch('/fleet/merge_shared_fs', {
			method: 'POST',
			headers: {'Content-Type': 'application/json'},
			body: JSON.stringify({enabled}),
		});
		addLog(`merge: shared filesystem ${enabled ? 'on' : 'off'}`, enabled ? 'green' : 'amber');
	} catch (e) {
		addLog('merge shared-fs update failed: ' + e.message, 'red');
	}
}

async function setMergeTargetNode(node_name) {
	_mergeTargetNode = node_name;
	try {
		await fetch('/fleet/merge_target_node', {
			method: 'POST',
			headers: {'Content-Type': 'application/json'},
			body: JSON.stringify({node_name}),
		});
		addLog(`merge node: ${node_name || 'random'}`, 'amber');
	} catch (e) {
		addLog('merge target node update failed: ' + e.message, 'red');
	}
}

// Patch update() to also sync fleet state from SSE data
const _origUpdate = update;
update = function(data) {
	_origUpdate(data);
	if (data.github !== undefined) {
		const g = data.github;
		_reposPhaseDone = g.pending === 0 && g.assigned === 0 && g.done > 0;
		_reposProblematic = g.problematic ?? 0;
		applyPhaseCheckboxDisabled();
	}
	if (data.stack !== undefined) {
		const s = data.stack;
		const prevStackDone = _stackPhaseDone;
		_stackPhaseDone = s.pending === 0 && (s.assigned || 0) === 0 && s.done > 0;
		_stackProblematic = s.problematic ?? 0;
		if (_stackPhaseDone && !prevStackDone) {
			// Phase 2 is done — disable the checkbox interaction but keep it checked
			applyPhaseEnableStyles();
			updatePhaseBtn(_fleetState, _fleetPhase);
		}
		applyPhaseCheckboxDisabled();
	}
	if (data.fleet_state !== undefined && data.fleet_phase !== undefined) {
		const prevState = _fleetState;
		const prevPhase = _fleetPhase;
		_fleetState = data.fleet_state;
		_fleetPhase = data.fleet_phase;
		if (prevPhase !== _fleetPhase || (_fleetState === 'running' && prevState !== 'running')) {
			_selectedPhase = null;
			updatePhaseSelectionStyles();
		}
		updatePhaseBtn(_fleetState, _fleetPhase);
		if (prevState !== _fleetState || prevPhase !== _fleetPhase) {
			if (_fleetState === 'running') {
				_phaseError = false;
				const banner = document.getElementById('phase-error-banner');
				if (banner) banner.style.display = 'none';
			}
			if (_fleetPhase >= 4) {
				_mergePhaseDone = true;
				applyPhaseCheckboxDisabled();
				addLog('all phases complete', 'green');
			} else if (_fleetState === 'running' && prevPhase !== _fleetPhase) {
				addLog(`phase ${_fleetPhase} started (auto)`, 'green');
			} else if (_fleetState === 'stopped' && prevState === 'running') {
				if (_fleetPhase > prevPhase) {
					addLog(`phase ${prevPhase} complete`, 'green');
				} else {
					addLog(`phase ${_fleetPhase} stopped`, 'red');
				}
			}
		}
	}
	if (data.merge_final_uploaded !== undefined) {
		const dl = document.getElementById('download-btn');
		if (dl) dl.style.display = data.merge_final_uploaded ? '' : 'none';
		if (data.merge_final_uploaded && !_mergeFinalUploaded) addLog('final dataset ready — download available', 'green');
		_mergeFinalUploaded = data.merge_final_uploaded;
	}
	if (data.fleet_phase_error !== undefined && data.fleet_phase_error !== _phaseError) {
		_phaseError = data.fleet_phase_error;
		const banner = document.getElementById('phase-error-banner');
		if (banner) banner.style.display = _phaseError ? '' : 'none';
		if (_phaseError) {
			if (_fleetPhase === 1 && _reposProblematic > 0) {
				addLog(`phase 1 stopped — ${_reposProblematic} repo(s) failed, retry available`, 'red');
			} else {
				addLog('auto-advance halted — phase completed with errors', 'red');
			}
		}
		updatePhaseBtn(_fleetState, _fleetPhase);
	}
	if (data.fleet_auto_advance !== undefined) {
		const chk = document.getElementById('auto-advance-chk');
		if (chk) chk.checked = data.fleet_auto_advance;
	}
	let phaseEnableChanged = false;
	if (data.fleet_github_enabled !== undefined) {
		const chk = document.getElementById('github-enabled-chk');
		if (chk) chk.checked = data.fleet_github_enabled;
		if (_githubEnabled !== data.fleet_github_enabled) { _githubEnabled = data.fleet_github_enabled; phaseEnableChanged = true; }
	}
	if (data.fleet_stack_enabled !== undefined) {
		const chk = document.getElementById('stack-enabled-chk');
		// Don't override the auto-disabled state when phase 2 is already done
		if (chk && !_stackPhaseDone) chk.checked = data.fleet_stack_enabled;
		if (_stackEnabled !== data.fleet_stack_enabled && !_stackPhaseDone) { _stackEnabled = data.fleet_stack_enabled; phaseEnableChanged = true; }
	}
	if (data.fleet_merge_enabled !== undefined) {
		const chk = document.getElementById('merge-enabled-chk');
		if (chk && !_mergePhaseDone) chk.checked = data.fleet_merge_enabled;
		const mergeSection = document.getElementById('merge-model-section');
		if (mergeSection) mergeSection.style.display = data.fleet_merge_enabled ? '' : 'none';
		if (_mergeEnabled !== data.fleet_merge_enabled) {
			_mergeEnabled = data.fleet_merge_enabled;
			phaseEnableChanged = true;
		}
	}
	if (data.fleet_merge_shared_fs !== undefined) {
		const chk = document.getElementById('merge-shared-fs-chk');
		if (chk) chk.checked = data.fleet_merge_shared_fs;
		_mergeSharedFs = data.fleet_merge_shared_fs;
	}
	if (data.fleet_merge_target_node !== undefined) {
		_mergeTargetNode = data.fleet_merge_target_node;
		const sel = document.getElementById('merge-target-node-sel');
		if (sel) sel.value = data.fleet_merge_target_node;
	}
	if (data.registered_node_offsets !== undefined) _nodeOffsets = data.registered_node_offsets;
	if (data.registered_phase1_threads !== undefined) _phase1Threads = data.registered_phase1_threads;
	if (data.registered_phase2_threads !== undefined) _phase2Threads = data.registered_phase2_threads;
	if (data.registered_node_names !== undefined) {
		const sel = document.getElementById('merge-target-node-sel');
		if (sel) {
			const current = _mergeTargetNode;
			// Rebuild options: random + all registered names
			const names = data.registered_node_names;
			const options = ['', ...names];
			const currentOptions = Array.from(sel.options).map(o => o.value);
			const same = options.length === currentOptions.length && options.every((v, i) => v === currentOptions[i]);
			if (!same) {
				sel.innerHTML = '<option value="">random</option>' +
					names.map(n => `<option value="${n}">${n}</option>`).join('');
			}
			sel.value = current;
		}
	}
	if (phaseEnableChanged) {
		updatePhaseBtn(_fleetState, _fleetPhase);
		applyPhaseEnableStyles();
	}
};

function applyPhaseCheckboxDisabled() {
	const githubChk = document.getElementById('github-enabled-chk');
	if (githubChk) githubChk.disabled = _reposPhaseDone;
	const stackChk = document.getElementById('stack-enabled-chk');
	if (stackChk) stackChk.disabled = _stackPhaseDone;
	const mergeChk = document.getElementById('merge-enabled-chk');
	if (mergeChk) mergeChk.disabled = _mergePhaseDone;
	const mergeSharedFsChk = document.getElementById('merge-shared-fs-chk');
	if (mergeSharedFsChk) mergeSharedFsChk.disabled = _mergePhaseDone;
	const mergeNodeSel = document.getElementById('merge-target-node-sel');
	if (mergeNodeSel) mergeNodeSel.disabled = _mergePhaseDone;
}

function applyPhaseEnableStyles() {
	const el1 = document.getElementById('progress-item-phase1');
	if (el1) el1.classList.toggle('progress-item--disabled', !_githubEnabled);
	const el2 = document.getElementById('progress-item-phase2');
	if (el2) el2.classList.toggle('progress-item--disabled', !_stackEnabled);
	const el3 = document.getElementById('progress-item-phase3');
	if (el3) el3.classList.toggle('progress-item--disabled', !_mergeEnabled);
}

function connect() {
	const dot = document.getElementById('status-dot');
	const text = document.getElementById('status-text');
	const es = new EventSource('/events');

	es.onopen = () => {
		dot.className = 'status-dot live';
		text.textContent = 'live';
		addLog('connected to coordinator', 'green');
	};

	es.onmessage = (e) => {
		try {
			update(JSON.parse(e.data));
		} catch (err) {
			addLog('parse error: ' + err.message, 'red');
		}
	};

	es.onerror = () => {
		dot.className = 'status-dot error';
		text.textContent = 'reconnecting...';
		es.close();
		addLog('connection lost, retrying in 3s...', 'red');
		setTimeout(connect, 3000);
	};
}

connect();
