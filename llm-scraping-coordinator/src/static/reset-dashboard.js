function showModal(id) {
	document.getElementById(id).classList.add('open');
}

function hideModal(id) {
	document.getElementById(id).classList.remove('open');
}

function showToast(msg, type) {
	const el = document.getElementById('toast');
	el.textContent = msg;
	el.className = `toast ${type} show`;
	setTimeout(() => { el.classList.remove('show'); }, 3500);
}

async function doReset(endpoint, btnId) {
	const btn = document.getElementById(btnId);
	btn.disabled = true;
	try {
		const res = await fetch(endpoint, {method: 'POST'});
		const data = await res.json();
		if (res.ok && data.ok) {
			showToast('done', 'success');
		} else {
			showToast('error: ' + (data.error ?? res.status), 'error');
		}
	} catch (err) {
		showToast('network error', 'error');
	} finally {
		btn.disabled = false;
	}
}

// Reset all
document.getElementById('btn-reset-all').addEventListener('click', () => showModal('modal-all'));
document.getElementById('cancel-all').addEventListener('click', () => hideModal('modal-all'));
document.getElementById('confirm-all').addEventListener('click', async () => {
	hideModal('modal-all');
	await doReset('/reset/all', 'btn-reset-all');
});

// Reset stack
document.getElementById('btn-reset-stack').addEventListener('click', () => showModal('modal-stack'));
document.getElementById('cancel-stack').addEventListener('click', () => hideModal('modal-stack'));
document.getElementById('confirm-stack').addEventListener('click', async () => {
	hideModal('modal-stack');
	await doReset('/reset/stack', 'btn-reset-stack');
});

// Retry repos problematic (sequential)
document.getElementById('btn-reset-repos-problematic').addEventListener('click', () => showModal('modal-repos-problematic'));
document.getElementById('cancel-repos-problematic').addEventListener('click', () => hideModal('modal-repos-problematic'));
document.getElementById('confirm-repos-problematic').addEventListener('click', async () => {
	hideModal('modal-repos-problematic');
	await doReset('/reset/repos_problematic', 'btn-reset-repos-problematic');
});

// Reset problematic
document.getElementById('btn-reset-problematic').addEventListener('click', () => showModal('modal-problematic'));
document.getElementById('cancel-problematic').addEventListener('click', () => hideModal('modal-problematic'));
document.getElementById('confirm-problematic').addEventListener('click', async () => {
	hideModal('modal-problematic');
	await doReset('/reset/problematic', 'btn-reset-problematic');
});

// Phase: merge
document.getElementById('btn-phase-merge').addEventListener('click', () => showModal('modal-phase-merge'));
document.getElementById('cancel-phase-merge').addEventListener('click', () => hideModal('modal-phase-merge'));
document.getElementById('confirm-phase-merge').addEventListener('click', async () => {
	hideModal('modal-phase-merge');
	await doReset('/reset/phase/merge', 'btn-phase-merge');
});

// Phase: stack
document.getElementById('btn-phase-stack').addEventListener('click', () => showModal('modal-phase-stack'));
document.getElementById('cancel-phase-stack').addEventListener('click', () => hideModal('modal-phase-stack'));
document.getElementById('confirm-phase-stack').addEventListener('click', async () => {
	hideModal('modal-phase-stack');
	await doReset('/reset/phase/stack', 'btn-phase-stack');
});

// Phase: repos
document.getElementById('btn-phase-repos').addEventListener('click', () => showModal('modal-phase-repos'));
document.getElementById('cancel-phase-repos').addEventListener('click', () => hideModal('modal-phase-repos'));
document.getElementById('confirm-phase-repos').addEventListener('click', async () => {
	hideModal('modal-phase-repos');
	await doReset('/reset/phase/repos', 'btn-phase-repos');
});

// Reset worker names
document.getElementById('btn-reset-worker-names').addEventListener('click', () => showModal('modal-worker-names'));
document.getElementById('cancel-worker-names').addEventListener('click', () => hideModal('modal-worker-names'));
document.getElementById('confirm-worker-names').addEventListener('click', async () => {
	hideModal('modal-worker-names');
	await doReset('/reset/worker_names', 'btn-reset-worker-names');
});

// Close modals on overlay click
document.querySelectorAll('.modal-overlay').forEach(overlay => {
	overlay.addEventListener('click', (e) => {
		if (e.target === overlay) overlay.classList.remove('open');
	});
});
