# Aperture · Rust backend (axum) — port 8701
# Every target delegates to supervisor.py, which owns build, pidfile,
# health-wait and the Tailscale URL printout.

PY    ?= python3
SUP   := $(PY) supervisor.py
PORT  := 8701

.DEFAULT_GOAL := help
.PHONY: help start stop restart status logs tail build clean distclean urls open test uitest

help: ## show this help
	@printf '\n  \033[1mAperture · Rust (axum)\033[0m  \033[2mport $(PORT)\033[0m\n\n'
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) \
	  | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-11s\033[0m %s\n", $$1, $$2}'
	@printf '\n  \033[2mmake start\033[0m prints the Tailscale URL to open on your iPhone.\n\n'

start: ## build if needed, start the server, print the Tailscale URL
	@$(SUP) start

stop: ## stop the server
	@$(SUP) stop

restart: ## stop then start
	@$(SUP) restart

status: ## is it running? show pid, port and URLs
	@$(SUP) status

urls: ## print local / LAN / Tailscale URLs
	@$(SUP) urls

logs: ## last 80 log lines
	@$(SUP) logs

tail: ## follow the log
	@$(SUP) logs -f

build: ## cargo build --release
	@$(SUP) build

open: ## open the gallery in the default browser
	@open http://localhost:$(PORT) 2>/dev/null || xdg-open http://localhost:$(PORT)

test: ## protocol test: chunked upload, interruption, resume, ranges
	@$(PY) ../smoketest.py $(PORT)

uitest: ## browser test: real uploads in Chromium, throttled + interrupted
	@node ../uitest.mjs $(PORT)

clean: ## remove build output
	@cargo clean
	@rm -rf .run
	@echo "cleaned build output (uploads in ./data kept)"

distclean: clean ## also delete every uploaded file
	@rm -rf data
	@echo "deleted ./data"
