.PHONY: build up down clean test logs

IMAGES := upnp-v1 upnp-v2 natpmp pcp-fake hostile broken
PREFIX := motrix-test

build:
	@for img in $(IMAGES); do \
	  echo "Building $$img..."; \
	  docker build -t $(PREFIX)/$$img:latest $$img/; \
	done

up:
	docker compose up -d

down:
	docker compose down --volumes

clean: down
	@for img in $(IMAGES); do \
	  docker rmi $(PREFIX)/$$img:latest 2>/dev/null || true; \
	done

test:
	pnpm exec vitest run tests/integration/nat-docker.test.ts

logs:
	docker compose logs -f
