# Grove dev convenience targets.
# Run `make` (no args) to see this help.

WEB_DIR := grove-web

.DEFAULT_GOAL := help

.PHONY: help
help:
	@awk 'BEGIN {FS = ":.*?## "} /^[a-zA-Z_-]+:.*?## / {printf "  \033[36m%-20s\033[0m %s\n", $$1, $$2}' $(MAKEFILE_LIST)

# ─── Run ────────────────────────────────────────────────────────────────

.PHONY: run
run: web ## Build web (prod) + run GUI without perf monitor
	cargo run --features gui -- gui

.PHONY: perf
perf: web-perf perf-run ## Build web (perf) + run GUI with backend perf-monitor enabled

.PHONY: perf-run
perf-run: ## Run GUI with perf-monitor (skip web rebuild — use existing dist)
	cargo run --features gui,perf-monitor -- gui

.PHONY: tui
tui: ## Run TUI (no GUI / no web build)
	cargo run

# ─── Web ────────────────────────────────────────────────────────────────

.PHONY: web
web: ## Build web frontend (production, no perf monitor)
	cd $(WEB_DIR) && npm run build

.PHONY: web-perf
web-perf: ## Build web frontend with perf monitor wired in
	cd $(WEB_DIR) && npm run build:perf

.PHONY: web-dev
web-dev: ## Start vite dev server (proxy /api to localhost:3001)
	cd $(WEB_DIR) && npm run dev

.PHONY: web-lint
web-lint: ## Run eslint on grove-web (zero warnings allowed)
	cd $(WEB_DIR) && npx eslint . --max-warnings 0

# ─── Rust ───────────────────────────────────────────────────────────────

.PHONY: check
check: ## cargo check across feature combos
	cargo check
	cargo check --features gui
	cargo check --features gui,perf-monitor

.PHONY: fmt
fmt: ## cargo fmt --all
	cargo fmt --all

.PHONY: lint
lint: ## cargo clippy across feature combos (warnings as errors)
	cargo clippy --features gui,perf-monitor -- -D warnings

.PHONY: test
test: ## cargo test
	cargo test

# ─── Combined ───────────────────────────────────────────────────────────

.PHONY: ci
ci: fmt lint test web-lint web ## Full pre-push check (fmt + clippy + test + web build)

.PHONY: clean
clean: ## Clean cargo + dist + node_modules build artifacts (keeps node_modules)
	cargo clean
	rm -rf $(WEB_DIR)/dist

# ─── Flamegraph ─────────────────────────────────────────────────────────

# Use a release binary for the flamegraph because debug builds spend most
# samples in unrelated codegen artifacts (panic helpers, debug bookkeeping)
# instead of the actual hot path. Release with debuginfo gives both real
# perf characteristics AND symbolicated stacks.

.PHONY: flamegraph-install
flamegraph-install: ## Install samply (Rust flamegraph profiler) if missing
	@which samply > /dev/null || cargo install samply
	@echo "samply ready: $$(samply --version)"

.PHONY: flamegraph-build
flamegraph-build: web-perf ## Build release binary with debuginfo for profiling
	RUSTFLAGS="-C force-frame-pointers=yes" cargo build --release --features gui,perf-monitor

.PHONY: flamegraph
flamegraph: flamegraph-install flamegraph-build ## Profile grove gui — Ctrl+C stops, opens Firefox Profiler
	@echo ""
	@echo "→ Recording. Trigger the operation you want to profile, then Ctrl+C."
	@echo ""
	samply record ./target/release/grove gui
