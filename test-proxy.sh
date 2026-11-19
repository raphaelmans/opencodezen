#!/usr/bin/env bash
# End-to-end check for an opencodezen Worker.
#
# Usage:  ./test-proxy.sh <worker-url> <route> <model>
#   route = opencode     OpenCode app pass-through, Console / Zen  (<worker>/opencode/v1)
#           opencode-go  OpenCode app pass-through, Go             (<worker>/opencode/go/v1)
#           zen | go     Anthropic-format routes for Claude Desktop / Claude Code
#   defaults: http://127.0.0.1:8787  opencode  gpt-5.4-nano
#
# The key is read from OPENCODE_API_KEY or a hidden prompt, and never printed.
# Note: free Zen models are refused when proxied (429 "Client IP address is
# required for free usage"); test with a paid Zen model or a Go model.
set -u
BASE="${1:-http://127.0.0.1:8787}"; BASE="${BASE%/}"
ROUTE="${2:-opencode}"
MODEL="${3:-gpt-5.4-nano}"
SESSION="proxy-test-$(uuidgen 2>/dev/null || date +%s)"

if [ -z "${OPENCODE_API_KEY:-}" ]; then
  read -rsp "OpenCode API key (hidden): " OPENCODE_API_KEY; echo
fi
pass=0; fail=0
check() { if [ "$1" = ok ]; then echo "PASS  $2"; pass=$((pass+1)); else echo "FAIL  $2"; echo "      $3" | head -c 600; echo; fail=$((fail+1)); fi; }
call() { r=$(curl -s -w '\n%{http_code}' "$@"); code=${r##*$'\n'}; body=${r%$'\n'*}; }

echo "Worker:  $BASE"
call "$BASE/"
echo "$body" | grep -q '"/opencode"' && check ok "Worker answers and has the /opencode route" || check bad "Worker info ($code)" "$body"

case "$ROUTE" in
  opencode|opencode-go)
    [ "$ROUTE" = opencode ] && URL="$BASE/opencode/v1" || URL="$BASE/opencode/go/v1"
    H=(-H "Authorization: Bearer $OPENCODE_API_KEY" -H "content-type: application/json" -H "x-opencode-session: $SESSION" -H "User-Agent: opencodezen-test-proxy/1.0")
    echo "Route:   $URL (pass-through), model $MODEL"; echo

    call "${H[@]}" "$URL/models"
    [ "$code" = 200 ] && check ok "GET /models (200)" || check bad "GET /models ($code)" "$body"
    echo "$body" | grep -q "\"$MODEL\"" && check ok "model '$MODEL' is listed" || check bad "model '$MODEL' not listed" "$(echo "$body" | grep -o '"id":"[^"]*"' | head -12 | tr '\n' ' ')"

    call "${H[@]}" "$URL/chat/completions" -d "{\"model\":\"$MODEL\",\"max_tokens\":50,\"messages\":[{\"role\":\"user\",\"content\":\"Reply with exactly: PROXY OK\"}]}"
    if [ "$code" = 200 ]; then check ok "POST /chat/completions (200)"; echo "      reply: $(echo "$body" | grep -o '"content":"[^"]*"' | head -1)"
    else
      # Some Zen models (GPT family) only speak the Responses API.
      call "${H[@]}" "$URL/responses" -d "{\"model\":\"$MODEL\",\"max_output_tokens\":50,\"input\":\"Reply with exactly: PROXY OK\"}"
      [ "$code" = 200 ] && check ok "POST /responses (200)" || check bad "chat/completions and responses both failed ($code)" "$body"
    fi
    ;;
  zen|go)
    URL="$BASE/$ROUTE"
    H=(-H "x-api-key: $OPENCODE_API_KEY" -H "anthropic-version: 2023-06-01" -H "content-type: application/json" -H "x-opencode-session: $SESSION")
    echo "Route:   $URL (Anthropic format), model $MODEL"; echo

    call "${H[@]}" "$URL/v1/models"
    [ "$code" = 200 ] && check ok "GET /v1/models (200)" || check bad "GET /v1/models ($code)" "$body"
    echo "$body" | grep -q "\"$MODEL\"" && check ok "model '$MODEL' is listed" || check bad "model '$MODEL' not listed" "$(echo "$body" | grep -o '"id":"[^"]*"' | head -12 | tr '\n' ' ')"

    call "${H[@]}" "$URL/v1/messages" -d "{\"model\":\"$MODEL\",\"max_tokens\":200,\"messages\":[{\"role\":\"user\",\"content\":\"Reply with exactly: PROXY OK\"}]}"
    if [ "$code" = 200 ] && echo "$body" | grep -q '"type":"message"'; then
      check ok "POST /v1/messages non-streaming"; echo "      reply: $(echo "$body" | grep -o '"text":"[^"]*"' | head -1)"
    else check bad "POST /v1/messages non-streaming ($code)" "$body"; fi

    s=$(curl -sN "${H[@]}" "$URL/v1/messages" -d "{\"model\":\"$MODEL\",\"max_tokens\":200,\"stream\":true,\"messages\":[{\"role\":\"user\",\"content\":\"Count 1 to 5.\"}]}")
    echo "$s" | grep -q message_start && echo "$s" | grep -q message_stop && check ok "POST /v1/messages streaming" || check bad "streaming" "$(echo "$s" | head -5)"

    call "${H[@]}" "$URL/v1/messages" -d "{\"model\":\"$MODEL\",\"max_tokens\":300,\"tools\":[{\"name\":\"get_weather\",\"description\":\"Get weather for a city\",\"input_schema\":{\"type\":\"object\",\"properties\":{\"city\":{\"type\":\"string\"}},\"required\":[\"city\"]}}],\"messages\":[{\"role\":\"user\",\"content\":\"What is the weather in Paris? Use the tool.\"}]}"
    echo "$body" | grep -q '"type":"tool_use"' && check ok "tool_use block returned" || check bad "no tool_use block" "$body"
    ;;
  *) echo "Unknown route '$ROUTE' (use opencode, opencode-go, zen or go)"; exit 2 ;;
esac

echo; echo "$pass passed, $fail failed"
unset OPENCODE_API_KEY
[ "$fail" = 0 ]
