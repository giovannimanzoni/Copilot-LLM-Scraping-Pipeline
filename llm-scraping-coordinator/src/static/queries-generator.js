/* global __toggleTheme */
"use strict";

const btnGenerate = document.getElementById("btn-generate");
const logArea     = document.getElementById("log-area");
const logLines    = document.getElementById("log-lines");
const resultArea  = document.getElementById("result-area");
const resultCount = document.getElementById("result-count");
const errorArea   = document.getElementById("error-area");
const errorText   = document.getElementById("error-text");
const toast       = document.getElementById("toast");
const langInput   = document.getElementById("language");
const starsInput  = document.getElementById("min-stars");

let toastTimer = null;
let activeSource = null;

function showToast(msg, type = "success") {
	toast.textContent = msg;
	toast.className = `toast ${type} show`;
	if (toastTimer) clearTimeout(toastTimer);
	toastTimer = setTimeout(() => { toast.className = "toast"; }, 2800);
}

function setLoading(on) {
	btnGenerate.disabled = on;
	btnGenerate.classList.toggle("loading", on);
	btnGenerate.textContent = on ? "scanning github…" : "scan repos";
}

function appendLog(msg) {
	logArea.style.display = "";
	const line = document.createElement("div");
	line.className = "log-line";
	line.textContent = msg;
	logLines.appendChild(line);
	logLines.scrollTop = logLines.scrollHeight;
}

function clearLog() {
	logLines.innerHTML = "";
	logArea.style.display = "none";
}

function showResult(count) {
	resultCount.textContent = `${count} repo${count === 1 ? "" : "s"}`;
	resultArea.style.display = "";
	errorArea.style.display = "none";
}

function showError(msg) {
	errorText.textContent = msg;
	errorArea.style.display = "";
	resultArea.style.display = "none";
}

btnGenerate.addEventListener("click", () => {
	// Close any previous stream
	if (activeSource) {
		activeSource.close();
		activeSource = null;
	}

	const language = langInput.value.trim() || "typescript";
	const minStars = parseInt(starsInput.value, 10) || 0;

	clearLog();
	resultArea.style.display = "none";
	errorArea.style.display = "none";
	setLoading(true);

	const url = `/utility/repo-scanner/stream?language=${encodeURIComponent(language)}&minStars=${minStars}`;
	const source = new EventSource(url);
	activeSource = source;

	source.addEventListener("log", (e) => {
		const {msg} = JSON.parse(e.data);
		appendLog(msg);
	});

	source.addEventListener("result", (e) => {
		const {count} = JSON.parse(e.data);
		source.close();
		activeSource = null;
		setLoading(false);
		showResult(count);
		showToast(`${count} repos written to repos_found.txt`);
	});

	source.addEventListener("error", (e) => {
		source.close();
		activeSource = null;
		setLoading(false);
		// SSE network errors fire with no data; only show message if payload present
		if (e.data) {
			const {msg} = JSON.parse(e.data);
			showError(msg);
		} else {
			showError("Connection error — check coordinator logs");
		}
	});
});

langInput.addEventListener("keydown", (e) => {
	if (e.key === "Enter") btnGenerate.click();
});
