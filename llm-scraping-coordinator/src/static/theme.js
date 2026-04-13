(function () {
	const saved = localStorage.getItem('theme') || 'dark';
	document.documentElement.setAttribute('data-theme', saved);

	function applyTheme(theme) {
		document.documentElement.setAttribute('data-theme', theme);
		localStorage.setItem('theme', theme);
		const btn = document.getElementById('theme-toggle');
		if (btn) btn.textContent = theme === 'light' ? '\u263D' : '\u2600';
	}

	window.__toggleTheme = function () {
		const current = document.documentElement.getAttribute('data-theme');
		applyTheme(current === 'light' ? 'dark' : 'light');
	};

	document.addEventListener('DOMContentLoaded', function () {
		const btn = document.getElementById('theme-toggle');
		if (btn) {
			const current = document.documentElement.getAttribute('data-theme');
			btn.textContent = current === 'light' ? '\u263D' : '\u2600';
		}
	});
})();
