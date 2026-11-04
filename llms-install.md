# Installing the Kipurse MCP server in Cline

Kipurse is a **remote** MCP server. There is nothing to download, build or run locally.

- Endpoint: `https://pay.kipurse.com/mcp`
- Transport: Streamable HTTP (Cline `"type": "streamableHttp"`)
- Auth: OAuth 2.1 + PKCE with dynamic client registration (MCP authorization spec). Cline shows an **Authenticate** button when the server answers `401`.
- Registry name: `com.kipurse/kipurse`

## 1. What the wallet owner must do first (cannot be automated)
1. Install the Kipurse iOS app and create a Kipurse wallet (a self-custodial smart wallet on Base, owned by the user's own Coinbase account).
2. Put a small amount of USDC in the wallet and set the AI limits in the app (defaults are low).
3. During step 3 below, the browser sign-in opens Kipurse; the owner approves connecting this AI agent in the Kipurse app (Face ID). The AI can only pay within those on-chain limits; new payees or larger amounts always need the owner's Face ID.

Do not ask the user for keys, seed phrases, passwords or tokens. None go in any file.

## 2. Add the server to `cline_mcp_settings.json`
Open Cline → MCP Servers icon → Configure → **Configure MCP Servers** (Cline CLI: `~/.cline/data/settings/cline_mcp_settings.json`). Merge this entry into `mcpServers`:

```json
{
  "mcpServers": {
    "kipurse": {
      "type": "streamableHttp",
      "url": "https://pay.kipurse.com/mcp",
      "disabled": false,
      "autoApprove": [],
      "timeout": 60
    }
  }
}
```

Notes:
- `"type"` must be exactly `streamableHttp`. If it is omitted Cline falls back to legacy SSE.
- Leave `autoApprove` empty: payment tools should always be confirmed by the user in Cline.
- No `headers` are needed. Authentication is done with OAuth in the next step.

Alternative UI: MCP Servers → **Remote Servers** tab → Server Name `kipurse`, Server URL `https://pay.kipurse.com/mcp`, Transport **Streamable HTTP** → Add Server.

## 3. Sign in
The `kipurse` row will say the server requires authentication. Click **Authenticate**. The browser opens `https://pay.kipurse.com/oauth/authorize`. The owner approves in the Kipurse app, then Cline reconnects on its own. CLI: run `cline mcp` and choose **Authorize OAuth**.

## 4. Quick test (read-only)
- In the MCP Servers panel the `kipurse` server should show a green status and a list of `kipurse_*` tools.
- Ask Cline: "List the tools of the kipurse MCP server and show my AI limits." This should call a read-only tool such as `kipurse_limits`. Do **not** call payment tools as a test.

## Troubleshooting
- `401 invalid_token` before signing in is expected. Discovery: `https://pay.kipurse.com/.well-known/oauth-protected-resource` and `https://pay.kipurse.com/.well-known/oauth-authorization-server`.
- `405` / SSE errors mean `"type": "streamableHttp"` is missing.
- `invalid_redirect_uri` during sign-in: update Cline. Current Cline uses a loopback callback (`http://127.0.0.1:<port>/...`), which Kipurse accepts. Some older VS Code builds registered a `vscode://` callback, which Kipurse rejects (only https or loopback http are allowed).
- `agent_paused` means the owner turned on "Pause AI payments" in the app.

Fees: a Kipurse service fee and actual network cost, both in USDC and deducted from the wallet balance. They are shown before approval. See `docs/fees/FEES.md`.
