# TradingView MCP — local setup

These steps must run on your own machine. A Claude Code cloud session cannot
do them: its config is discarded when the container is reclaimed, and there is
no desktop TradingView app or GUI to attach to.

## 1. Install the server

```
git clone <tradingview-mcp-repo-url> ~/tradingview-mcp
cd ~/tradingview-mcp && npm install
```

If the directory already exists, `git pull` instead of cloning.

The URL in the original guide (`comstantsdontlie/tradingview-mcp`) did not
resolve — confirm the correct repo before running this.

## 2. Register the server with Claude Code

Merge `config/mcp-entry.json` into `~/.claude.json`, replacing `<HOME>` with
your absolute home path. If `mcpServers` already exists, add the `tradingview`
key to it rather than overwriting the object.

## 3. Rules file

Copy `config/rules.json` to `~/tradingview-mcp/rules.json`.

## 4. Launch TradingView with remote debugging

```
# macOS
/Applications/TradingView.app/Contents/MacOS/TradingView --remote-debugging-port=9222
# Windows
%LOCALAPPDATA%\TradingView\TradingView.exe --remote-debugging-port=9222
# Linux
/opt/TradingView/TradingView --remote-debugging-port=9222
```

Port 9222 is how the MCP server drives the app.

## 5. Verify

Run the server's `tv_health_check` tool; expect `cdp_connected: true`.

## 6. Final validation

Fetch BTCUSDT and confirm: MCP connected, rules file present, TradingView
listening on 9222, current price returned.
