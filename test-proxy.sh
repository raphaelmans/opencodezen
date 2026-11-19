#!/usr/bin/env bash
# Tests the opencode-cowork-proxy Worker the same way Claude Desktop calls it
# (Anthropic Messages format, x-api-key auth).
# Usage:  ./test-proxy.sh [worker-url] [route] [model]
#   defaults: http://127.0.0.1:8787  go  qwen3.8-flash
# Your key is read silently from the prompt (or OPENCODE_API_KEY) and never printed.
set -u
BASE="${1:-http://127.0.0.1:8787}"; BASE="${BASE%/}"
ROUTE="${2:-go}"
MODEL="${3:-qwen3.8-flash}"
URL="$BASE/$ROUTE"

if [ -z "${OPENCODE_API_KEY:-}" ]; then
  read -rsp "OpenCode API key (hidden): " OPENCODE_API_KEY; echo
fi
H=(-H "x-api-key: $OPENCODE_API_KEY" -H "anthropic-version: 2023-06-01" -H "content-type: application/json" -H "x-opencode-session: proxy-test-$(uuidgen)")
pass=0; fail=0
check() { if [ "$1" = ok ]; then echo "PASS  $2"; pass=$((pass+1)); else echo "FAIL  $2"; echo "      $3" | head -c 600; echo; fail=$((fail+1)); fi; }

echo "Testing $URL with model $MODEL"; echo

# 1. Model list
r=$(curl -s -w '\n%{http_code}' "${H[@]}" "$URL/v1/models"); code=${r##*$'\n'}; body=${r%$'\n'*}
[ "$code" = 200 ] && check ok "GET /v1/models (200)" || check bad "GET /v1/models ($code)" "$body"
echo "$body" | grep -q "\"$MODEL\"" && check ok "model '$MODEL' is listed" || check bad "model '$MODEL' not in list" "$(echo "$body" | grep -o '"id":"[^"]*"' | head -15 | tr '\n' ' ')"

# 2. Non-streaming message
r=$(curl -s -w '\n%{http_code}' "${H[@]}" "$URL/v1/messages" \
  -d "{\"model\":\"$MODEL\",\"max_tokens\":200,\"messages\":[{\"role\":\"user\",\"content\":\"Reply with exactly: PROXY OK\"}]}")
code=${r##*$'\n'}; body=${r%$'\n'*}
if [ "$code" = 200 ] && echo "$body" | grep -q '"type":"message"'; then
  check ok "POST /v1/messages non-streaming (Anthropic-shaped reply)"
  echo "      reply: $(echo "$body" | grep -o '"text":"[^"]*"' | head -1)"
else check bad "POST /v1/messages non-streaming ($code)" "$body"; fi

# 3. Streaming message (what Claude Desktop actually uses)
s=$(curl -sN "${H[@]}" "$URL/v1/messages" \
  -d "{\"model\":\"$MODEL\",\"max_tokens\":200,\"stream\":true,\"messages\":[{\"role\":\"user\",\"content\":\"Count 1 to 5.\"}]}")
if echo "$s" | grep -q 'message_start' && echo "$s" | grep -q 'message_stop'; then
  check ok "POST /v1/messages streaming (message_start ... message_stop)"
else check bad "streaming" "$(echo "$s" | head -5)"; fi

# 4. Tool use (Claude Desktop relies on tools)
r=$(curl -s "${H[@]}" "$URL/v1/messages" -d "{\"model\":\"$MODEL\",\"max_tokens\":300,
  \"tools\":[{\"name\":\"get_weather\",\"description\":\"Get weather for a city\",\"input_schema\":{\"type\":\"object\",\"properties\":{\"city\":{\"type\":\"string\"}},\"required\":[\"city\"]}}],
  \"messages\":[{\"role\":\"user\",\"content\":\"What is the weather in Paris? Use the tool.\"}]}")
echo "$r" | grep -q '"type":"tool_use"' && check ok "tool_use block returned" || check bad "no tool_use block" "$r"

echo; echo "$pass passed, $fail failed"
unset OPENCODE_API_KEY
