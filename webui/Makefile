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
# If unset, and .env points IPTV_LS_DB at a file on this machine, that file is
# used automatically — a host path means nothing inside the container, so it has
# to be mounted rather than passed through as an environment variable.
#   make run LS_DB="$HOME/Library/Application Support/<App>/Local Storage/file__0.localstorage"
LS_DB ?= $(shell sed -n 's/^IPTV_LS_DB=//p' $(ENV_FILE) 2>/dev/null | tail -1 | sed 's/^"//;s/"$$//')

# This machine's LAN address, handed to the container so the phone remote can
# advertise something reachable. Inside a container all we'd otherwise see is a
# private bridge address, and the container's port rather than the published one.
HOST_IP ?= $(shell ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || hostname -I 2>/dev/null | awk '{print $$1}')

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
	CREDS=""; \
	if [ -f "$(ENV_FILE)" ]; then \
	  ARGS="$$ARGS --env-file $(ENV_FILE)"; CREDS="$(ENV_FILE)"; \
	fi; \
	if [ -f "config.json" ]; then CREDS="$${CREDS:+$$CREDS + }config.json"; fi; \
	if [ -n "$(LS_DB)" ] && [ -f "$(LS_DB)" ]; then \
	  cp "$(LS_DB)" "$(CREDS_COPY)"; \
	  ARGS="$$ARGS -v $(CURDIR)/$(CREDS_COPY):/creds/file__0.localstorage:ro"; \
	  ARGS="$$ARGS -e IPTV_LS_DB=/creds/file__0.localstorage"; \
	  CREDS="$${CREDS:+$$CREDS + }mounted localStorage"; \
	fi; \
	if [ -n "$$CREDS" ]; then \
	  echo "-> credentials: $$CREDS"; \
	else \
	  echo "!! no creds: set IPTV_* in $(ENV_FILE), or copy config.example.json to config.json"; \
	fi; \
	if [ -f "config.json" ]; then \
	  ARGS="$$ARGS -v $(CURDIR)/config.json:/app/config.json:ro"; \
	fi; \
	if [ -n "$(HOST_IP)" ]; then \
	  ARGS="$$ARGS -e REMOTE_HOST=$(HOST_IP) -e REMOTE_PORT=$(PORT)"; \
	  echo "-> phone remote: http://$(HOST_IP):$(PORT)"; \
	else \
	  echo "!! couldn't detect this machine's LAN address — pass HOST_IP=... for the phone remote"; \
	fi; \
	echo "-> http://localhost:$(PORT)"; \
	TTY=""; if [ -t 0 ]; then TTY="-it"; fi; \
	docker run $$TTY $$ARGS $(IMAGE)

logs:
	docker logs -f $(IMAGE)

stop:
	-docker rm -f $(IMAGE)

clean: stop
	-docker rmi $(IMAGE)
	-rm -f $(CREDS_COPY)

clean-cache:
	-docker volume rm iptv-cache
