#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_COMPOSE_FILE="$ROOT_DIR/docker-compose.yml"
BASE_COMPOSE_FILE="$ROOT_DIR/ollama/compose.yaml"
GPU_COMPOSE_FILE="$ROOT_DIR/ollama/compose.gpu.yaml"
OLLAMA_CONTAINER_NAME="${OLLAMA_CONTAINER_NAME:-rtd-ollama}"
OPEN_WEBUI_CONTAINER_NAME="${OPEN_WEBUI_CONTAINER_NAME:-rtd-open-webui}"
ASKDOCS_BACKEND_URL="${ASKDOCS_BACKEND_URL:-http://127.0.0.1:8000}"
MODEL="${OLLAMA_MODEL:-llama3.2:3b}"
OPEN_WEBUI_ENABLED="${OPEN_WEBUI_ENABLED:-1}"
ACCELERATION_MODE="cpu"
COMPOSE_ARGS=(-f "$BACKEND_COMPOSE_FILE" -f "$BASE_COMPOSE_FILE")
SERVICES=(ollama askdocs-backend)

require_command() {
  local command_name="$1"
  if ! command -v "$command_name" >/dev/null 2>&1; then
    echo "Missing required command: $command_name" >&2
    exit 1
  fi
}

wait_for_ollama() {
  local ready="false"

  echo "Waiting for Ollama to become ready..."
  for attempt in $(seq 1 60); do
    if docker exec "$OLLAMA_CONTAINER_NAME" ollama list >/dev/null 2>&1; then
      ready="true"
      break
    fi
    sleep 2
  done

  if [[ "$ready" != "true" ]]; then
    echo "Ollama did not become ready in time." >&2
    return 1
  fi
}

wait_for_http_url() {
  local url="$1"
  local label="$2"
  local attempts="${3:-90}"

  if ! command -v curl >/dev/null 2>&1; then
    echo "curl not found. Skipping $label HTTP readiness check."
    return 0
  fi

  echo "Waiting for $label at $url ..."
  for attempt in $(seq 1 "$attempts"); do
    if curl --max-time 3 -fsS -o /dev/null "$url"; then
      return 0
    fi
    sleep 2
  done

  echo "$label did not become reachable at $url in time." >&2
  return 1
}

start_stack() {
  local log_file
  log_file="$(mktemp)"

  if docker compose "${COMPOSE_ARGS[@]}" up -d "${SERVICES[@]}" >"$log_file" 2>&1; then
    cat "$log_file"
    rm -f "$log_file"
    return 0
  fi

  cat "$log_file" >&2

  if [[ "$ACCELERATION_MODE" == "gpu" ]] && grep -Fq 'capabilities: [[gpu]]' "$log_file"; then
    rm -f "$log_file"
    echo "Docker could not attach an NVIDIA GPU to the Ollama container. Falling back to CPU mode." >&2
    echo "This usually means the NVIDIA Container Toolkit is not installed or Docker is not configured for GPU workloads yet." >&2
    ACCELERATION_MODE="cpu"
    docker compose "${COMPOSE_ARGS[@]}" down >/dev/null 2>&1 || true
    COMPOSE_ARGS=(-f "$BACKEND_COMPOSE_FILE" -f "$BASE_COMPOSE_FILE")
    echo "Retrying local stack startup in CPU mode..."
    docker compose "${COMPOSE_ARGS[@]}" up -d "${SERVICES[@]}"
    return 0
  fi

  rm -f "$log_file"
  return 1
}

require_command docker
export OLLAMA_BASE_URL="${OLLAMA_BASE_URL:-http://ollama:11434}"

if [[ "${OLLAMA_FORCE_CPU:-0}" == "1" ]]; then
  echo "CPU fallback forced via OLLAMA_FORCE_CPU=1."
elif [[ "${OLLAMA_SKIP_GPU_CHECK:-0}" == "1" ]]; then
  if [[ -f "$GPU_COMPOSE_FILE" ]]; then
    ACCELERATION_MODE="gpu"
    COMPOSE_ARGS+=(-f "$GPU_COMPOSE_FILE")
    echo "Skipping host GPU health check and attempting NVIDIA GPU mode."
  fi
elif command -v nvidia-smi >/dev/null 2>&1; then
  if nvidia-smi >/dev/null 2>&1; then
    if [[ -f "$GPU_COMPOSE_FILE" ]]; then
      ACCELERATION_MODE="gpu"
      COMPOSE_ARGS+=(-f "$GPU_COMPOSE_FILE")
      echo "NVIDIA GPU detected and healthy. Starting Ollama with GPU acceleration."
    fi
  else
    echo "NVIDIA GPU check failed. Falling back to CPU mode." >&2
    echo "Run: bash ./gpu-info.sh" >&2
    echo "Most likely fix on this host: reboot into the latest installed kernel, then retry for GPU mode." >&2
  fi
else
  echo "nvidia-smi not found. Falling back to CPU mode."
fi

if [[ "$OPEN_WEBUI_ENABLED" == "1" ]]; then
  SERVICES+=(open-webui)
  echo "Open WebUI is enabled and will be started alongside Ollama."
else
  echo "Open WebUI is disabled via OPEN_WEBUI_ENABLED=0."
fi

echo "Starting local stack in $ACCELERATION_MODE mode..."
if ! start_stack; then
  exit 1
fi

if ! wait_for_ollama; then
  docker compose "${COMPOSE_ARGS[@]}" logs --tail=100 ollama || true
  exit 1
fi

if ! wait_for_http_url "$ASKDOCS_BACKEND_URL/health" "AskDocs backend health endpoint" 90; then
  docker compose "${COMPOSE_ARGS[@]}" logs --tail=100 askdocs-backend || true
  exit 1
fi

echo "Pulling model: $MODEL"
docker exec "$OLLAMA_CONTAINER_NAME" ollama pull "$MODEL"

if [[ "$OPEN_WEBUI_ENABLED" == "1" ]]; then
  if ! wait_for_http_url "http://127.0.0.1:3000/health" "Open WebUI health endpoint" 120; then
    docker compose "${COMPOSE_ARGS[@]}" logs --tail=100 open-webui || true
    exit 1
  fi
fi

echo
echo "Local AskDocs stack is ready."
echo "Backend API:  $ASKDOCS_BACKEND_URL"
echo "Database:     $ROOT_DIR/data/askdocs.db"
echo "Ollama API:   http://127.0.0.1:11434/api"
echo "Model:        $MODEL"
echo "Mode:         $ACCELERATION_MODE"
if [[ "$OPEN_WEBUI_ENABLED" == "1" ]]; then
  echo "Open WebUI:   http://127.0.0.1:3000"
  echo "UI container: $OPEN_WEBUI_CONTAINER_NAME"
fi
echo "Chrome:       load unpacked extension from $ROOT_DIR/chrome-extension"
