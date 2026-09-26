import express from "express";

import { isUnauthorized } from "./mcp/mcpClient.js";

/**
 * **The MCP routes: connect, log in, list tools, disconnect.**
 *
 * Everything here goes through one `McpClient`, so none of it knows about
 * transports, OAuth or the SDK. A 401 — no tokens, or tokens the SDK could
 * not refresh — is `200 { ok: false, authUrl }`: a state the UI draws a
 * Connect button for, not an error.
 *
 * @param {{ mcp: import("./mcp/mcpClient.js").McpClient }} deps
 */
export function mcpRoutes({ mcp }) {
  const router = express.Router();

  router.get("/mcp/status", async (_req, res) => {
    try {
      res.json(await mcp.status());
    } catch (err) {
      console.error("[/mcp/status]", err?.message ?? err);
      res.status(500).json({ error: "Could not read the MCP status." });
    }
  });

  router.post("/mcp/connect", async (_req, res) => {
    try {
      const result = await mcp.connect();
      res.json(result.ok ? { ok: true, serverInfo: result.serverInfo } : { ok: false, authUrl: result.authUrl });
    } catch (err) {
      console.error("[/mcp/connect]", err?.message ?? err);
      res.status(502).json({ ok: false, error: `Could not reach ${mcp.server}: ${err?.message ?? err}` });
    }
  });

  router.get("/mcp/oauth/callback", async (req, res) => {
    const { code, state, error, error_description: description } = req.query;
    if (error) {
      return res.status(400).type("html").send(page("Not connected", String(description || error), false));
    }
    if (typeof code !== "string" || !code) {
      return res.status(400).type("html").send(page("Not connected", "The callback had no authorization code.", false));
    }

    try {
      const result = await mcp.finishAuth(code, typeof state === "string" ? state : undefined);
      if (!result.ok) {
        return res.status(401).type("html").send(page("Not connected", "The server still wants authorization.", false));
      }
      res.type("html").send(page("Connected", `${mcp.server} is connected. You can close this tab.`, true));
    } catch (err) {
      console.error("[/mcp/oauth/callback]", err?.message ?? err);
      res.status(400).type("html").send(page("Not connected", String(err?.message ?? err), false));
    }
  });

  router.get("/mcp/tools", async (_req, res) => {
    try {
      const connected = await mcp.connect();
      if (!connected.ok) return res.json({ ok: false, authUrl: connected.authUrl, tools: [] });
      const tools = await mcp.listTools();
      res.json({ ok: true, tools });
    } catch (err) {
      if (isUnauthorized(err)) return res.json({ ok: false, authUrl: mcp.authUrl, tools: [] });
      console.error("[/mcp/tools]", err?.message ?? err);
      res.status(502).json({ ok: false, error: `Could not list tools: ${err?.message ?? err}` });
    }
  });

  router.post("/mcp/disconnect", async (_req, res) => {
    try {
      await mcp.disconnect();
      res.json({ ok: true });
    } catch (err) {
      console.error("[/mcp/disconnect]", err?.message ?? err);
      res.status(500).json({ ok: false, error: "Could not disconnect." });
    }
  });

  return router;
}

/**
 * The page the popup lands on. It tells the opener, then tries to close
 * itself; the text is for the browsers that will not let it.
 */
function page(title, message, ok) {
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
  try { window.opener && window.opener.postMessage({ type: "mcp-auth", ok: ${ok ? "true" : "false"} }, location.origin); } catch (e) {}
  ${ok ? "setTimeout(() => window.close(), 800);" : ""}
</script>
</body>`;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}
