import express from "express";

import { describeError, isUnauthorized } from "./mcp/mcpClient.js";

/**
 * **The MCP routes: connect, log in, list tools, disconnect — per server.**
 *
 * `/mcp/servers` lists what is registered; everything else is
 * `/mcp/:server/…` and goes through that server's `McpClient`, so none of it
 * knows about transports, OAuth or the SDK, and none of it knows which server
 * is Notion. Two answers are states the UI draws, not errors:
 *
 *   - a 401 — no tokens, or tokens the SDK could not refresh — is
 *     `200 { ok: false, authUrl }`: a Connect button;
 *   - a server that cannot be reached is `200 { ok: false, connected: false,
 *     error }`: a red dot with the reason.
 *
 * A server with `auth: "none"` never produces an `authUrl`.
 *
 * @param {{ registry: import("./mcp/servers.js").McpRegistry }} deps
 */
export function mcpRoutes({ registry }) {
  const router = express.Router();

  router.get("/mcp/servers", (_req, res) => {
    res.json({ servers: registry.list().map(({ id, name, auth }) => ({ id, name, auth })) });
  });

  // The OAuth callback is one URL for every OAuth server — it is what was
  // registered with them — so the `state` decides whose login it finishes.
  // Declared before the `:server` routes so "oauth" is never read as an id.
  router.get("/mcp/oauth/callback", async (req, res) => {
    const { code, state, error, error_description: description } = req.query;
    if (error) {
      return res.status(400).type("html").send(page("Not connected", String(description || error), false));
    }
    if (typeof code !== "string" || !code) {
      return res.status(400).type("html").send(page("Not connected", "The callback had no authorization code.", false));
    }

    try {
      const mcp = await ownerOf(registry, typeof state === "string" ? state : undefined);
      if (!mcp) throw new Error("OAuth state did not match — start the connection again.");
      const result = await mcp.finishAuth(code, state);
      if (!result.ok) {
        return res.status(401).type("html").send(page("Not connected", "The server still wants authorization.", false, mcp.server));
      }
      res.type("html").send(page("Connected", `${nameOf(registry, mcp.server)} is connected. You can close this tab.`, true, mcp.server));
    } catch (err) {
      console.error("[/mcp/oauth/callback]", err?.message ?? err);
      res.status(400).type("html").send(page("Not connected", String(err?.message ?? err), false));
    }
  });

  /** Resolve `:server`, or answer 404 and return nothing. */
  const client = (req, res) => {
    const mcp = registry.get(req.params.server);
    if (!mcp) res.status(404).json({ ok: false, error: `No MCP server "${req.params.server}".` });
    return mcp;
  };

  router.get("/mcp/:server/status", async (req, res) => {
    const mcp = client(req, res);
    if (!mcp) return;
    try {
      const { name, auth } = registry.definition(mcp.server);
      res.json({ ...(await mcp.status()), name, auth });
    } catch (err) {
      console.error(`[/mcp/${mcp.server}/status]`, err?.message ?? err);
      res.status(500).json({ error: "Could not read the MCP status." });
    }
  });

  router.post("/mcp/:server/connect", async (req, res) => {
    const mcp = client(req, res);
    if (!mcp) return;
    try {
      const result = await mcp.connect();
      if (result.ok) return res.json({ ok: true, connected: true, serverInfo: result.serverInfo });
      res.json({ ok: false, connected: false, authUrl: result.authUrl });
    } catch (err) {
      console.warn(`[/mcp/${mcp.server}/connect]`, describeError(err));
      res.json({ ok: false, connected: false, error: unreachable(registry, mcp, err) });
    }
  });

  router.get("/mcp/:server/tools", async (req, res) => {
    const mcp = client(req, res);
    if (!mcp) return;
    try {
      const connected = await mcp.connect();
      if (!connected.ok) return res.json({ ok: false, authUrl: connected.authUrl, tools: [] });
      const tools = await mcp.listTools();
      res.json({ ok: true, tools });
    } catch (err) {
      if (mcp.auth === "oauth" && isUnauthorized(err)) return res.json({ ok: false, authUrl: mcp.authUrl, tools: [] });
      console.warn(`[/mcp/${mcp.server}/tools]`, describeError(err));
      res.json({ ok: false, connected: false, error: unreachable(registry, mcp, err), tools: [] });
    }
  });

  router.post("/mcp/:server/disconnect", async (req, res) => {
    const mcp = client(req, res);
    if (!mcp) return;
    try {
      await mcp.disconnect();
      res.json({ ok: true });
    } catch (err) {
      console.error(`[/mcp/${mcp.server}/disconnect]`, err?.message ?? err);
      res.status(500).json({ ok: false, error: "Could not disconnect." });
    }
  });

  return router;
}

/** Which OAuth server started the login this `state` belongs to. */
async function ownerOf(registry, state) {
  if (!state) return null;
  for (const mcp of registry.clients()) {
    if (await mcp.ownsState(state).catch(() => false)) return mcp;
  }
  return null;
}

function nameOf(registry, id) {
  return registry.definition(id)?.name ?? id;
}

function unreachable(registry, mcp, err) {
  return `Could not reach ${nameOf(registry, mcp.server)} at ${mcp.url}: ${describeError(err)}`;
}

/**
 * The page the popup lands on. It tells the opener, then tries to close
 * itself; the text is for the browsers that will not let it.
 */
function page(title, message, ok, server = null) {
  const text = escapeHtml(message);
  return `<!doctype html>
<meta charset="utf-8">
<title>${escapeHtml(title)}</title>
<meta name="color-scheme" content="light dark">
<body style="font: 14px system-ui, sans-serif; padding: 40px; max-width: 480px; margin: auto">
<h1 style="font-size: 18px">${escapeHtml(title)}</h1>
<p>${text}</p>
<p><a href="/">Back to the app</a></p>
<script>
  try { window.opener && window.opener.postMessage({ type: "mcp-auth", server: ${JSON.stringify(server).replace(/</g, "\\u003c")}, ok: ${ok ? "true" : "false"} }, location.origin); } catch (e) {}
  ${ok ? "setTimeout(() => window.close(), 800);" : ""}
</script>
</body>`;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}
