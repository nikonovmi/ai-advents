import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { StoredOAuthProvider } from "../mcp/oauthProvider.js";
import { JsonMcpAuthStore, MemoryMcpAuthStore } from "./mcpAuthStore.js";

async function tempStore(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-auth-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return { dir, store: new JsonMcpAuthStore({ dir }) };
}

test("a server never seen is an empty record, not an error", async (t) => {
  const { store } = await tempStore(t);
  assert.deepEqual(await store.load("notion"), { server: "notion", updatedAt: null });
});

test("the file store round-trips through a fresh instance", async (t) => {
  const { dir, store } = await tempStore(t);
  await store.update("notion", (record) => {
    record.clientInformation = { client_id: "abc" };
    record.tokens = { access_token: "at", refresh_token: "rt", token_type: "Bearer" };
  });

  const again = new JsonMcpAuthStore({ dir });
  const record = await again.load("notion");
  assert.equal(record.server, "notion");
  assert.deepEqual(record.clientInformation, { client_id: "abc" });
  assert.equal(record.tokens.refresh_token, "rt");
  assert.equal(typeof record.updatedAt, "string");
});

test("writes are atomic: .tmp then rename, owner-only, nothing left behind", async (t) => {
  const { dir, store } = await tempStore(t);

  const renames = [];
  const rename = fs.rename;
  fs.rename = async (from, to) => {
    renames.push([path.basename(from), path.basename(to)]);
    return rename(from, to);
  };
  t.after(() => {
    fs.rename = rename;
  });

  await store.update("notion", (record) => {
    record.tokens = { access_token: "at" };
  });

  assert.deepEqual(renames, [["notion.json.tmp", "notion.json"]]);
  assert.deepEqual(await fs.readdir(dir), ["notion.json"]);
  assert.equal((await fs.stat(path.join(dir, "notion.json"))).mode & 0o777, 0o600);
});

test("back-to-back updates both land", async (t) => {
  const { store } = await tempStore(t);
  const provider = new StoredOAuthProvider({ store, server: "notion" });

  // What the SDK does on a first login, without awaiting in between.
  await Promise.all([
    provider.saveClientInformation({ client_id: "abc" }),
    provider.saveCodeVerifier("verifier"),
    provider.saveDiscoveryState({ authorizationServerUrl: "https://auth.example.test" }),
  ]);

  const record = await store.load("notion");
  assert.equal(record.clientInformation.client_id, "abc");
  assert.equal(record.codeVerifier, "verifier");
  assert.equal(await provider.codeVerifier(), "verifier");
});

test("clear deletes the file; clearing twice is fine", async (t) => {
  const { dir, store } = await tempStore(t);
  await store.update("notion", (record) => {
    record.tokens = { access_token: "at" };
  });
  await store.clear("notion");
  await store.clear("notion");
  assert.deepEqual(await fs.readdir(dir), []);
});

test("a server name never becomes a path it should not", async (t) => {
  const { store } = await tempStore(t);
  await assert.rejects(store.update("../etc", () => {}), /Invalid MCP server name/);
});

test("the provider registers as a public PKCE client and keeps the URL it was given", async () => {
  const provider = new StoredOAuthProvider({ store: new MemoryMcpAuthStore(), server: "notion" });
  assert.deepEqual(provider.clientMetadata, {
    client_name: "first-agent",
    redirect_uris: ["http://localhost:3000/mcp/oauth/callback"],
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
  });

  provider.redirectToAuthorization(new URL("https://auth.example.test/authorize?x=1"));
  assert.equal(provider.authorizationUrl.href, "https://auth.example.test/authorize?x=1");
});

test("invalidateCredentials drops only what it names", async () => {
  const store = new MemoryMcpAuthStore();
  const provider = new StoredOAuthProvider({ store, server: "notion" });
  await provider.saveClientInformation({ client_id: "abc" });
  await provider.saveTokens({ access_token: "at", token_type: "Bearer" });

  await provider.invalidateCredentials("tokens");
  assert.equal(await provider.tokens(), undefined);
  assert.deepEqual(await provider.clientInformation(), { client_id: "abc" });

  await provider.invalidateCredentials("all");
  assert.equal(await provider.clientInformation(), undefined);
});
