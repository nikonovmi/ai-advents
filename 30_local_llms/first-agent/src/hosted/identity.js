import crypto from "node:crypto";

/**
 * **Who is asking (Day 30): the tailnet identity Tailscale Serve adds.**
 *
 * Tailscale Serve (checked against 1.104) proxies each request from a
 * user-owned device with:
 *
 *   - `Tailscale-User-Login` — `alice@example.com`, or `alice@github`;
 *   - `Tailscale-User-Name` — the display name (RFC 2047 encoded when it is not ASCII);
 *   - `Tailscale-User-Profile-Pic` — an image URL.
 *
 * **These headers are trusted only because the hosted server listens on
 * 127.0.0.1.** Nothing on the network can reach that port; the one way in is
 * Tailscale Serve, which sets the headers itself for the device's owner. A
 * client on this Mac could send any value — it is the owner's own machine.
 * Binding the server to another address would make every header here a
 * claim anyone could forge: never do that.
 *
 * No header — a request from this machine, or from a device shared with a
 * tagged identity, which Serve sends without one — is the user `local`. Not an error.
 */

export const LOCAL_USER = "local";
const HEADERS = { login: "tailscale-user-login", name: "tailscale-user-name", pic: "tailscale-user-profile-pic" };

/**
 * @param {import("express").Request} req
 * @returns {{ login: string, name: string, pic: string | null, tailnet: boolean }}
 */
export function identityOf(req) {
  const login = decodeWord(req.get?.(HEADERS.login) ?? req.headers?.[HEADERS.login]).trim().slice(0, 256);
  if (!login) return { login: LOCAL_USER, name: LOCAL_USER, pic: null, tailnet: false };
  const name = decodeWord(req.get?.(HEADERS.name) ?? req.headers?.[HEADERS.name]).trim().slice(0, 256);
  const pic = String(req.get?.(HEADERS.pic) ?? "").trim();
  return { login: login.toLowerCase(), name: name || login, pic: /^https:\/\//.test(pic) ? pic : null, tailnet: true };
}

/** Express middleware: `req.user`. */
export function identity() {
  return (req, _res, next) => {
    req.user = identityOf(req);
    next();
  };
}

/**
 * A header value, with RFC 2047 encoded-words (`=?utf-8?q?Ren=C3=A9?=`,
 * `=?utf-8?b?...?=`) decoded. Anything else is returned as it is.
 */
export function decodeWord(value) {
  const raw = String(value ?? "");
  return raw.replace(/=\?([^?]+)\?([qQbB])\?([^?]*)\?=/g, (whole, charset, encoding, text) => {
    try {
      const bytes =
        encoding.toLowerCase() === "b"
          ? Buffer.from(text, "base64")
          : Buffer.from(text.replace(/_/g, " ").replace(/=([0-9a-f]{2})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16))), "latin1");
      return new TextDecoder(charset).decode(bytes);
    } catch {
      return whole;
    }
  });
}

/**
 * The directory a user's conversations live in: a readable slug of the login
 * plus a hash of it, so two logins never share one and no login can name a
 * path outside the data directory.
 */
export function userDirName(login) {
  const slug = String(login).toLowerCase().replace(/[^a-z0-9._@-]+/g, "_").replace(/^[._]+/, "").slice(0, 48) || "user";
  const hash = crypto.createHash("sha256").update(String(login)).digest("hex").slice(0, 10);
  return `${slug}-${hash}`;
}
