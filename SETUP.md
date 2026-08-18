# Setup

The server now lives in this repository — there is no external repo to clone.

```
git clone https://github.com/Bearspeed77/Claude-Tradingview ~/tradingview-mcp
cd ~/tradingview-mcp
npm install
npm test
npm run smoke
```

Then merge `config/mcp-entry.json` into `~/.claude.json` (replacing `<HOME>`)
and restart Claude Code. `tv_health_check` should report `ready: true`.

See README.md for the tool list and design notes.
