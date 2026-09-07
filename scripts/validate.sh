#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

node --check desktop/plugin.js
node --experimental-vm-modules tests/provider_usage_logic_test.mjs
node --experimental-vm-modules tests/provider_scope_behavior_test.mjs
node --experimental-vm-modules tests/provider_render_test.mjs
python -m py_compile dashboard/plugin_api.py
python -c "import json; json.load(open('dashboard/manifest.json', encoding='utf-8')); print('manifest=PASS')"
git diff --check