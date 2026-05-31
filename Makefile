# Grove dev convenience targets.
# Run `make` (no args) to see this help.
#
# Append `PERF=1` to enable perf-monitor (backend instrumentation + frontend
# perf panel). Applies to gui / web / web-build:
#   make gui              # plain
#   PERF=1 make gui       # with perf-monitor
#   PERF=1 make web

WEB_DIR := grove-web

.DEFAULT_GOAL := help

ifeq ($(PERF),1)
  WEB_BUILD_SCRIPT := build:perf
  GUI_FEATURES := gui,perf-monitor
  WEB_FEATURES := --features perf-monitor
else
  WEB_BUILD_SCRIPT := build
  GUI_FEATURES := gui
  WEB_FEATURES :=
endif

.PHONY: help
help:
	@awk 'BEGIN {FS = ":.*?## "} /^[a-zA-Z_-]+:.*?## / {printf "  \033[36m%-20s\033[0m %s\n", $$1, $$2}' $(MAKEFILE_LIST)

# ─── Run ────────────────────────────────────────────────────────────────

.PHONY: gui
gui: web-build ## Run GUI desktop window (PERF=1 enables perf-monitor)
	cargo run --features $(GUI_FEATURES) -- gui

.PHONY: web
web: web-build ## Run grove web server (browser at localhost:3001; PERF=1 for perf-monitor)
	cargo run $(WEB_FEATURES) -- web

.PHONY: mobile
mobile: web-build ## Run mobile LAN server (phone/tablet via HMAC; PERF=1 for perf-monitor)
	cargo run $(WEB_FEATURES) -- mobile

.PHONY: tui
tui: ## Run TUI (no web build)
	cargo run

# ─── Web ────────────────────────────────────────────────────────────────

.PHONY: web-build
web-build: ## Build web frontend (PERF=1 wires in perf monitor)
	cd $(WEB_DIR) && pnpm run $(WEB_BUILD_SCRIPT)

.PHONY: web-dev
web-dev: ## Start vite dev server (proxy /api to localhost:3001)
	cd $(WEB_DIR) && pnpm run dev

.PHONY: web-lint
web-lint: ## Run eslint on grove-web — mirrors .github/workflows/ci.yml eslint job
	cd $(WEB_DIR) && pnpm eslint src/ --max-warnings 0

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
ci: fmt lint test web-lint web-build ## Full pre-push check (fmt + clippy + test + web build)

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
flamegraph-build: ## Build release binary with debuginfo for profiling (uses PERF=1 web build)
	$(MAKE) PERF=1 web-build
	RUSTFLAGS="-C force-frame-pointers=yes" cargo build --release --features gui,perf-monitor

.PHONY: flamegraph
flamegraph: flamegraph-install flamegraph-build ## Profile grove gui — Ctrl+C stops, opens Firefox Profiler
	@echo ""
	@echo "→ Recording. Trigger the operation you want to profile, then Ctrl+C."
	@echo ""
	samply record ./target/release/grove gui
