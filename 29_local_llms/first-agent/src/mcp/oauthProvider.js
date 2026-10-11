import crypto from "node:crypto";

/**
 * **Our side of the MCP authorization spec.**
 *
 * The SDK does the protocol — discovery, dynamic client registration, PKCE,
 * the code exchange, refreshing. This is the `OAuthClientProvider` it asks for
 * everything it has to remember or hand to a person, and the answer to both is
 * "the app": what it remembers goes to an `McpAuthStore`, and the one thing it
 * would hand to a person — the authorization URL — is captured rather than
 * opened, so a route can give it to the browser that asked.
 *
 * Nothing here is cached in memory except that URL. Every read goes to the
 * store, which is what lets the CLI and the server share one login.
 */

export const DEFAULT_REDIRECT_URL = "http://localhost:3000/mcp/oauth/callback";

export class StoredOAuthProvider {
  #store;
  #server;
  #redirectUrl;

  /** The URL the SDK wanted to send the user to, from the last attempt. @type {URL | null} */
  authorizationUrl = null;

  /**
   * @param {{ store: import("../store/mcpAuthStore.js").McpAuthStore, server: string, redirectUrl?: string }} options
   */
  constructor({ store, server, redirectUrl = DEFAULT_REDIRECT_URL }) {
    this.#store = store;
    this.#server = server;
    this.#redirectUrl = redirectUrl;
  }

  get redirectUrl() {
    return this.#redirectUrl;
  }

  get clientMetadata() {
    return {
      client_name: "first-agent",
      redirect_uris: [this.#redirectUrl],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      // A public client: no secret, PKCE instead.
      token_endpoint_auth_method: "none",
    };
  }

  /** A fresh `state` per authorization, kept so the callback can be checked. */
  async state() {
    const state = crypto.randomBytes(16).toString("base64url");
    await this.#patch((record) => {
      record.state = state;
    });
    return state;
  }

  /** Whether a callback's `state` is the one we sent. */
  async checkState(state) {
    const { state: expected } = await this.#store.load(this.#server);
    if (!expected || typeof state !== "string") return false;
    const a = Buffer.from(expected);
    const b = Buffer.from(state);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }

  async clientInformation() {
    return (await this.#store.load(this.#server)).clientInformation;
  }

  async saveClientInformation(clientInformation) {
    await this.#patch((record) => {
      record.clientInformation = clientInformation;
    });
  }

  async tokens() {
    return (await this.#store.load(this.#server)).tokens;
  }

  async saveTokens(tokens) {
    await this.#patch((record) => {
      record.tokens = tokens;
      // The login this verifier and state belonged to is over.
      delete record.codeVerifier;
      delete record.state;
    });
  }

  /** Not a browser: the URL is kept for whoever asked to connect. */
  redirectToAuthorization(authorizationUrl) {
    this.authorizationUrl = new URL(authorizationUrl);
  }

  async saveCodeVerifier(codeVerifier) {
    await this.#patch((record) => {
      record.codeVerifier = codeVerifier;
    });
  }

  async codeVerifier() {
    const { codeVerifier } = await this.#store.load(this.#server);
    if (!codeVerifier) throw new Error("No PKCE code verifier saved — start the authorization again.");
    return codeVerifier;
  }

  async saveDiscoveryState(discoveryState) {
    await this.#patch((record) => {
      record.discoveryState = discoveryState;
    });
  }

  async discoveryState() {
    return (await this.#store.load(this.#server)).discoveryState;
  }

  /**
   * The SDK saying some of what we hold is no good: a revoked refresh token,
   * a registration the server has forgotten.
   *
   * @param {"all" | "client" | "tokens" | "verifier" | "discovery"} scope
   */
  async invalidateCredentials(scope) {
    if (scope === "all") return this.#store.clear(this.#server);
    await this.#patch((record) => {
      if (scope === "client") delete record.clientInformation;
      if (scope === "tokens") delete record.tokens;
      if (scope === "verifier") delete record.codeVerifier;
      if (scope === "discovery") delete record.discoveryState;
    });
  }

  /** Whether there is anything to try connecting with. */
  async hasTokens() {
    return Boolean((await this.#store.load(this.#server)).tokens?.access_token);
  }

  #patch(mutate) {
    return this.#store.update(this.#server, mutate);
  }
}
