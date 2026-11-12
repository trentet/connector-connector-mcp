# Shared by the requirement-gate hooks (REQ-G001, REQ-G002). Install once per clone:
#   git config core.hooksPath scripts/hooks
# Python: HELM_REQ_GATE_PYTHON, else the host's gate venv (PyYAML), else python3/python on PATH.
gate() {
  PY="${HELM_REQ_GATE_PYTHON:-}"
  if [ -z "$PY" ] && [ -x "C:/ProgramData/HELM/req-gate/venv/Scripts/python.exe" ]; then PY="C:/ProgramData/HELM/req-gate/venv/Scripts/python.exe"; fi
  if [ -z "$PY" ]; then PY="$(command -v python3 || command -v python)"; fi
  exec "$PY" "$(git rev-parse --show-toplevel)/scripts/req_gate.py" "$@"
}
