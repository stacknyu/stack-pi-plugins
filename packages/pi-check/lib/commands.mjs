// Which bash commands are checks (routed through the broker) and which run go test/vet (go shim).
// Commands whose results depend only on the files: safe to share and replay.
const RUNNER = /^(npx|bunx|pnpm(\s+(exec|dlx))?|yarn(\s+exec)?|bun\s+x)\s+/;
const CHECK_TOOL = /^(vitest|jest|pytest|tsc|vue-tsc|eslint|oxlint|ruff|mypy|pyright)(\s|$)/;
const PY_MODULE = /^((python3?|uv\s+run(\s+python3?)?|poetry\s+run(\s+python3?)?)\s+-m\s+(pytest|mypy|ruff)|(uv|poetry)\s+run\s+(pytest|mypy|ruff|pyright))(\s|$)/;
const PKG_SCRIPT = /^(pnpm|npm|yarn|bun)\s+((-r|--recursive|-w|--filter\s+\S+|-F\s+\S+|--workspace\s+\S+|--prefix\s+\S+|-C\s+\S+|--dir\s+\S+|--silent|-s)\s+)*(run\s+)?(test|typecheck|type-check|lint|check|tsc|test:[\w:-]+|lint:[\w:-]+)(\s|$)/;
// …unless they change files, watch, or install.
const SIDE_EFFECTS = /--fix\b|--write\b|\s-u(\s|$)|--update(Snapshot)?\b|--watch\b|\bvitest\s+(watch|dev)\b|(npm|pnpm|yarn|bun|pip3?|uv|poetry)\s+(install|add|i|sync)\b|--init\b|\bformat\b|\bprettier\b|--generate|--emit\b|--build\b|\btsc\s+(-b|--build)\b|>\s*[\w./-]+\.(ts|tsx|js|py|go|json)\b/;

export function segments(command) {
	return command
		.split(/&&|\|\||;|\||\n|\(|\)/)
		.map((s) => s.trim().replace(/^(\w+=\S*\s+)+/, "").replace(/^(time|env|nice(\s+-n\s*-?\d+)?)\s+/, ""))
		.filter(Boolean);
}

export function isCheckCommand(command) {
	if (SIDE_EFFECTS.test(command)) return false;
	return segments(command).some((seg) => {
		const s = seg.replace(RUNNER, "");
		return CHECK_TOOL.test(s) || PY_MODULE.test(seg) || PKG_SCRIPT.test(seg);
	});
}

export function isGoCommand(command) {
	return segments(command).some((s) => /^go\s+(test|vet)(\s|$)/.test(s) || /^(make|just|task|mage)(\s|$)/.test(s));
}
