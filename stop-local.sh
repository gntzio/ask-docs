#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_COMPOSE_FILE="$ROOT_DIR/docker-compose.yml"
BASE_COMPOSE_FILE="$ROOT_DIR/ollama/compose.yaml"
GPU_COMPOSE_FILE="$ROOT_DIR/ollama/compose.gpu.yaml"
COMPOSE_ARGS=(-f "$BACKEND_COMPOSE_FILE" -f "$BASE_COMPOSE_FILE")

if [[ -f "$GPU_COMPOSE_FILE" ]]; then
  COMPOSE_ARGS+=(-f "$GPU_COMPOSE_FILE")
fi

docker compose "${COMPOSE_ARGS[@]}" down
