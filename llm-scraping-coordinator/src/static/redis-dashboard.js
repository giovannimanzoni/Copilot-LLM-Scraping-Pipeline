const collapsed = new Set();

function toggle(id) {
	const el = document.getElementById(id);
	const tog = document.getElementById('toggle-' + id);
	if (!el) return;
	if (collapsed.has(id)) {
		collapsed.delete(id);
		el.classList.remove('collapsed');
		if (tog) tog.textContent = '▼';
	} else {
		collapsed.add(id);
		el.classList.add('collapsed');
		if (tog) tog.textContent = '▶';
	}
}

function fmt(n) {
	if (n == null || n === '') return '—';
	return Number(n).toLocaleString();
}

function fmtTs(sec) {
	if (!sec) return '—';
	return new Date(sec * 1000).toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
}

function ageClass(min) {
	if (min < 10) return 'age-ok';
	if (min < 30) return 'age-warn';
	return 'age-dead';
}

function chips(list, cls) {
	if (!list || list.length === 0) return '<div class="empty">empty</div>';
	return list.map(v => `<span class="chip ${cls}">${v}</span>`).join('');
}

function update(data) {
	const k = data.keys;
	const nodes = data.nodes;
	const now = data.ts;

	// Keys overview
	const keyDefs = [
		{name: '{repos}:pending',    type: 'SET',        count: k.repos_pending.count,     badgeCls: 'badge-set'},
		{name: '{repos}:assigned',   type: 'ZSET',       count: k.repos_assigned.count,    badgeCls: 'badge-zset'},
		{name: '{repos}:done',       type: 'SET',        count: k.repos_done.count,         badgeCls: 'badge-set'},
		{name: '{repos}:cancelled',  type: 'SET',        count: k.repos_cancelled.count,    badgeCls: 'badge-set'},
		{name: '{stack}:pending',    type: 'LIST',       count: k.stack_pending.count,      badgeCls: 'badge-list'},
		{name: '{stack}:assigned',   type: 'ZSET',       count: k.stack_assigned.count,     badgeCls: 'badge-zset'},
		{name: '{stack}:done',       type: 'SET',        count: k.stack_done.count,         badgeCls: 'badge-set'},
		{name: '{stack}:problematic',type: 'SET',        count: k.stack_problematic.count,  badgeCls: k.stack_problematic.count > 0 ? 'badge-zero' : 'badge-set'},
		{name: '{node}:N:heartbeat', type: 'STRING TTL', count: data.total_workers + ' nodes',  badgeCls: 'badge-str'},
		{name: '{node}:N:stats',     type: 'HASH',       count: data.total_workers + ' hashes', badgeCls: 'badge-hash'},
	];

	document.getElementById('keys-grid').innerHTML = keyDefs.map(kd => `
		<div class="key-card">
			<div class="key-card-name"><span>{</span>${kd.name.replace('{','').replace('}','}')}</div>
			<div class="key-card-count">${typeof kd.count === 'number' ? fmt(kd.count) : kd.count}</div>
			<div class="key-card-type">${kd.type}</div>
		</div>
	`).join('');

	// Repos assigned
	document.getElementById('repos-assigned-count').textContent = fmt(k.repos_assigned.count);
	const raTbody = document.getElementById('repos-assigned-table');
	if (k.repos_assigned.entries.length === 0) {
		raTbody.innerHTML = '<tr><td colspan="3" class="empty">no assigned repos</td></tr>';
	} else {
		raTbody.innerHTML = k.repos_assigned.entries
			.sort((a, b) => b.ageMin - a.ageMin)
			.map(e => `<tr>
				<td><span style="color:var(--teal)">${e.repo}</span></td>
				<td style="color:var(--text3)">${fmtTs(e.assignedAt)}</td>
				<td class="${ageClass(e.ageMin)}">${e.ageMin}m ago</td>
			</tr>`).join('');
	}

	// Repos pending sample
	document.getElementById('repos-pending-count').textContent = fmt(k.repos_pending.count);
	document.getElementById('repos-pending-chips').innerHTML = chips(k.repos_pending.members.sort(), 'chip-pending');

	// Repos done count
	document.getElementById('repos-done-count').textContent = fmt(k.repos_done.count);

	// Repos cancelled sample
	document.getElementById('repos-cancelled-count').textContent = fmt(k.repos_cancelled.count);
	document.getElementById('repos-cancelled-chips').innerHTML = chips(k.repos_cancelled.sample.sort(), 'chip-pending');

	// Stack assigned
	document.getElementById('stack-assigned-count').textContent = fmt(k.stack_assigned.count);
	const saTbody = document.getElementById('stack-assigned-table');
	if (k.stack_assigned.entries.length === 0) {
		saTbody.innerHTML = '<tr><td colspan="4" class="empty">no assigned stack tasks</td></tr>';
	} else {
		saTbody.innerHTML = k.stack_assigned.entries.map(e => `<tr>
			<td style="color:var(--purple)">${e.key}</td>
			<td style="color:var(--text3)">${fmtTs(e.assignedAt)}</td>
			<td class="${ageClass(e.ageMin)}">${e.ageMin}m ago</td>
			<td style="color:var(--text3);font-size:10px">${e.task ? JSON.stringify(e.task) : '—'}</td>
		</tr>`).join('');
	}

	// Stack pending
	document.getElementById('stack-pending-count').textContent = fmt(k.stack_pending.count);
	const spTbody = document.getElementById('stack-pending-table');
	if (k.stack_pending.sample.length === 0) {
		spTbody.innerHTML = '<tr><td colspan="4" class="empty">empty</td></tr>';
	} else {
		spTbody.innerHTML = k.stack_pending.sample.map((t, i) => `<tr>
			<td style="color:var(--text3)">${i}</td>
			<td style="color:var(--amber)">${t.lang ?? '?'}</td>
			<td style="color:var(--purple)">${t.batch_index ?? '?'}</td>
			<td style="color:var(--text3)">${t.total_batches ?? '?'}</td>
		</tr>`).join('');
	}

	// Stack done
	document.getElementById('stack-done-count').textContent = fmt(k.stack_done.count);
	document.getElementById('stack-done-chips').innerHTML = chips(k.stack_done.members, 'chip-done');

	// Stack problematic
	document.getElementById('stack-problematic-count').textContent = fmt(k.stack_problematic.count);
	const spContent = document.getElementById('stack-problematic-content');
	if (k.stack_problematic.entries.length === 0) {
		spContent.innerHTML = '<div class="empty" style="padding:12px">no problematic tasks</div>';
	} else {
		spContent.innerHTML = `<div class="table-wrap"><table class="data-table">
			<thead><tr><th>key</th><th>task json</th></tr></thead>
			<tbody>${k.stack_problematic.entries.map(e => `<tr>
				<td style="color:var(--red)">${e.key}</td>
				<td style="color:var(--text3);font-size:10px">${e.task ? JSON.stringify(e.task) : '—'}</td>
			</tr>`).join('')}</tbody>
		</table></div>`;
	}

	// Nodes heartbeats
	const hbGrid = document.getElementById('nodes-hb-grid');
	let hbHtml = '';
	const now_hb = Date.now();
	const sortedNodeIds = Object.keys(nodes).map(Number).sort((a, b) => a - b);
	for (const i of sortedNodeIds) {
		const n = nodes[i] ?? {};
		const ttl = n.heartbeatTtl;
		const lastHb = parseInt(n.stats?.last_heartbeat) || 0;
		const msAgo = lastHb > 0 ? now_hb - lastHb : Infinity;
		const alive  = ttl > 0;
		const busy   = !alive && lastHb > 0 && msAgo < 20 * 60 * 1000;
		const unseen = !lastHb;
		const cardCls = unseen ? 'hb-unseen' : alive ? 'hb-alive' : busy ? 'hb-busy' : 'hb-dead';
		const ttlCls  = unseen ? 'unseen' : alive ? 'alive' : busy ? 'busy' : 'dead';
		const ttlStr  = unseen ? '—' : alive ? ttl + 's' : busy ? Math.round(msAgo / 60000) + 'm ago' : 'GONE';
		const samples = n.stats?.samples_collected ?? '0';
		const nodeName = n.stats?.node_name || '';
		const workerTag = `worker-${String(i).padStart(2, '0')}`;
		const displayName = nodeName ? `${nodeName} <span style="color:var(--text3)">(${workerTag})</span>` : workerTag;
		hbHtml += `<div class="hb-card ${cardCls}">
			<div class="hb-id"><span>${displayName}</span><span class="tag ${unseen ? 'tag-unseen' : alive ? 'tag-alive' : busy ? 'tag-busy' : 'tag-dead'}">${unseen ? '—' : alive ? 'LIVE' : busy ? 'BUSY' : 'DEAD'}</span></div>
			<div class="hb-ttl ${ttlCls}">${ttlStr}</div>
			<div class="hb-samples">${fmt(samples)} samples</div>
		</div>`;
	}
	hbGrid.innerHTML = hbHtml;

	// Nodes table
	const nTbody = document.getElementById('nodes-table');
	let nHtml = '';
	for (const i of sortedNodeIds) {
		const s = (nodes[i] ?? {}).stats ?? {};
		const ttl = (nodes[i] ?? {}).heartbeatTtl;
		const alive = ttl > 0;
		const lastHbRow = parseInt(s.last_heartbeat) || 0;
		const msAgoRow = lastHbRow > 0 ? now_hb - lastHbRow : Infinity;
		const busyRow = !alive && lastHbRow > 0 && msAgoRow < 20 * 60 * 1000;
		const unseen = !s.last_heartbeat;
		if (unseen) continue;
		const repo = s.current_repo || '';
		const repoShort = repo ? repo.split('/').pop() : '—';
		const nodeNameRow = s.node_name || '';
		const workerTagRow = `worker-${String(i).padStart(2, '0')}`;
		const displayNameRow = nodeNameRow ? `${nodeNameRow} (${workerTagRow})` : workerTagRow;
		nHtml += `<tr>
			<td style="color:var(--text2)">${displayNameRow}</td>
			<td class="${alive ? 'age-ok' : busyRow ? 'age-busy' : 'age-dead'}">${alive ? ttl + 's' : busyRow ? Math.round(msAgoRow / 60000) + 'm' : 'DEAD'}</td>
			<td style="color:var(--teal)">${fmt(s.samples_collected)}</td>
			<td>${fmt(s.repos_done)}</td>
			<td style="color:${parseInt(s.repos_failed) > 0 ? 'var(--red)' : 'var(--text3)'}">${fmt(s.repos_failed)}</td>
			<td style="color:var(--purple)">${fmt(s.stack_samples_done)}</td>
			<td class="truncate" style="color:var(--text3);max-width:180px">${repoShort}</td>
			<td style="color:var(--amber)">${s.current_stack || '—'}</td>
		</tr>`;
	}
	nTbody.innerHTML = nHtml || '<tr><td colspan="8" class="empty">no node data yet</td></tr>';

	document.getElementById('last-update').textContent = new Date(data.ts).toTimeString().slice(0, 8);
}

function connect() {
	const dot = document.getElementById('status-dot');
	const text = document.getElementById('status-text');
	const es = new EventSource('/redis/events');

	es.onopen = () => {
		dot.className = 'status-dot live';
		text.textContent = 'live';
	};

	es.onmessage = (e) => {
		try { update(JSON.parse(e.data)); }
		catch (err) { console.error('parse error', err); }
	};

	es.onerror = () => {
		dot.className = 'status-dot error';
		text.textContent = 'reconnecting...';
		es.close();
		setTimeout(connect, 3000);
	};
}

connect();
