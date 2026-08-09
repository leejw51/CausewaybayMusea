# Aperture — one photo/video gallery, three backends.
#
#   myrust        Rust · axum            :8701
#   mypython      Python · http.server   :8702
#   mytypescript  TypeScript · node:http :8703
#
# Each folder has its own Makefile and python supervisor; this one fans out.

PY    ?= python3
DIRS  := myrust mypython mytypescript

.DEFAULT_GOAL := help
.PHONY: help start stop restart status urls test uitest chunktest verify fixtures deps clean distclean $(DIRS)

help: ## show this help
	@printf '\n  \033[1mAperture\033[0m \033[2m— 4 GB resumable photo & video uploads, three ways\033[0m\n\n'
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) \
	  | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-10s\033[0m %s\n", $$1, $$2}'
	@printf '\n  \033[2mbackends\033[0m\n'
	@printf '    \033[36mmyrust\033[0m        Rust · axum              \033[2m:8701\033[0m\n'
	@printf '    \033[36mmypython\033[0m      Python · http.server     \033[2m:8702\033[0m\n'
	@printf '    \033[36mmytypescript\033[0m  TypeScript · node:http   \033[2m:8703\033[0m\n'
	@printf '\n  \033[2mcd into any backend folder for its own targets (logs, tail, build, open).\033[0m\n\n'

start: ## start all three, then print the remote URL to connect to
	@for d in $(DIRS); do $(MAKE) -s -C $$d start >/dev/null || exit 1; done
	@$(PY) urls.py

stop: ## stop all three
	@for d in $(DIRS); do $(MAKE) -s -C $$d stop; done

restart: stop start ## stop then start all three

status: ## show what is running
	@for d in $(DIRS); do $(MAKE) -s -C $$d status; done

urls: ## print the remote (Tailscale) URL for all three
	@$(PY) urls.py

test: ## protocol tests against all three (chunking, resume, ranges)
	@$(PY) smoketest.py all

uitest: ## browser tests against all three (Chromium, throttled + interrupted)
	@node uitest.mjs all

chunktest: ## browser test: small-chunk policy + resume-after-reload, all three
	@for p in 8701 8702 8703; do node chunktest.mjs $$p || exit 1; done

verify: test uitest chunktest ## run every test suite

fixtures: ## generate test media with ffmpeg (add MB=500 for a big one)
	@./fixtures.sh $(MB)

deps: ## install the Playwright package used by uitest
	@npm install --no-audit --no-fund
	@npx playwright install chromium

clean: ## stop everything and clean build output (uploads kept)
	@$(MAKE) -s stop
	@for d in $(DIRS); do $(MAKE) -s -C $$d clean; done

distclean: ## clean plus delete every upload, fixture and node_modules
	@$(MAKE) -s stop
	@for d in $(DIRS); do $(MAKE) -s -C $$d distclean; done
	@rm -rf fixtures node_modules .playwright-mcp
	@echo "removed fixtures, node_modules and all uploaded data"

myrust mypython mytypescript: ## e.g. `make myrust` starts just that one
	@$(MAKE) -s -C $@ start
