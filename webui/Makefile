# IPTV Player Grid — build & run helpers.
#
#   make dev     run locally with Node (no Docker), uses host credentials
#   make build   build the Docker image
#   make run     run the container (mounts creds file, or uses .env overrides)
#   make logs    tail container logs
#   make stop    stop & remove the container
#   make clean   remove image + local creds copy

IMAGE       ?= iptv-player-grid
PORT        ?= 8090
ENV_FILE    ?= .env
CREDS_COPY  := .iptv-creds.localstorage

# Optional: path to a desktop IPTV app's localStorage DB to mount for creds.
# Leave empty to use .env instead. Example:
#   make run LS_DB="$HOME/Library/Application Support/<App>/Local Storage/file__0.localstorage"
LS_DB ?=

.PHONY: dev build run logs stop clean clean-cache help

help:
	@grep -E '^#   make' $(MAKEFILE_LIST) | sed 's/^#   /  /'

dev:
	cd server && npm install && PORT=$(PORT) npm start

build:
	docker build -t $(IMAGE) .

run: build
	@set -e; \
	ARGS="--rm --name $(IMAGE) -p $(PORT):8080 -v iptv-cache:/cache"; \
	if [ -n "$(LS_DB)" ] && [ -f "$(LS_DB)" ]; then \
	  cp "$(LS_DB)" "$(CREDS_COPY)"; \
	  ARGS="$$ARGS -v $(CURDIR)/$(CREDS_COPY):/creds/file__0.localstorage:ro -e IPTV_LS_DB=/creds/file__0.localstorage"; \
	  echo "-> credentials: mounted localStorage"; \
	elif [ -f "$(ENV_FILE)" ]; then \
	  ARGS="$$ARGS --env-file $(ENV_FILE)"; \
	  echo "-> credentials: $(ENV_FILE)"; \
	else \
	  echo "!! no creds file at LS_DB and no $(ENV_FILE) — set IPTV_* in $(ENV_FILE) (see .env.example)"; \
	fi; \
	echo "-> http://localhost:$(PORT)"; \
	docker run -it $$ARGS $(IMAGE)

logs:
	docker logs -f $(IMAGE)

stop:
	-docker rm -f $(IMAGE)

clean: stop
	-docker rmi $(IMAGE)
	-rm -f $(CREDS_COPY)

clean-cache:
	-docker volume rm iptv-cache
