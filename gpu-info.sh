#!/usr/bin/env bash
set -euo pipefail

echo "[PCI devices]"
if command -v rg >/dev/null 2>&1; then
  lspci | rg -i "vga|3d|display|nvidia" || true
else
  lspci | grep -Ei "vga|3d|display|nvidia" || true
fi

echo
echo "[nvidia-smi]"
if command -v nvidia-smi >/dev/null 2>&1; then
  nvidia-smi || true
else
  echo "nvidia-smi not found"
fi

echo
echo "[nvidia-smi summary]"
if command -v nvidia-smi >/dev/null 2>&1; then
  nvidia-smi --query-gpu=name,driver_version,memory.total --format=csv,noheader || true
else
  echo "nvidia-smi not found"
fi

echo
echo "[NVIDIA driver version]"
if [[ -f /proc/driver/nvidia/version ]]; then
  cat /proc/driver/nvidia/version
else
  echo "/proc/driver/nvidia/version not found"
fi

echo
echo "[quick diagnosis]"
if command -v nvidia-smi >/dev/null 2>&1; then
  if nvidia_smi_output="$(nvidia-smi 2>&1)"; then
    echo "nvidia-smi is working."
  else
    echo "$nvidia_smi_output"
    if grep -qi "Driver/library version mismatch" <<<"$nvidia_smi_output"; then
      echo
      echo "Detected NVIDIA driver/library mismatch."
      echo "This usually means the userspace NVIDIA packages were updated, but the running kernel module is older."
      echo "Common fix: reboot into the newest installed kernel, then rerun this script."
    fi
  fi
else
  echo "nvidia-smi not found"
fi
