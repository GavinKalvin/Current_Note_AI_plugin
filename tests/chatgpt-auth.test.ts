import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { ChatGptAuth, ChatGptAuthStore } from "../src/provider/chatgpt-auth";

const account = "b37a0123-4567-4234-9234-123456789abc";
const client = "oaiapp_fixture";
const scope = "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct";
const roots: string[] = [];
async function fixture(config: { token?: "valid" | "signature" | "issuer" | "audience" | "expired" | "nonce"; scope?: string; subject?: string; clientId?: string; revokeFails?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), "chatgpt-auth-test-")); roots.push(root);
  const store = new ChatGptAuthStore(root);
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  const { privateKey: otherKey } = await generateKeyPair("RS256");
  const jwk = await exportJWK(publicKey); jwk.kid = "test-key"; jwk.alg = "RS256"; jwk.use = "sig";
  let callbackNonce = "";
  const fetchMock = vi.fn(async (url: string, options?: { method?: string; body?: string }) => {
    if (url === "https://auth.openai.com/.well-known/jwks.json") return JSON.stringify({ keys: [jwk] });
    if (url === "https://auth.openai.com/api/accounts/oauth/token") {
      const fields = new URLSearchParams(options?.body);
      const claims = config.token === "issuer" ? { issuer: "https://evil.example", audience: client, nonce: callbackNonce }
        : config.token === "audience" ? { issuer: "https://auth.openai.com", audience: "other-client", nonce: callbackNonce }
          : config.token === "nonce" ? { issuer: "https://auth.openai.com", audience: client, nonce: "wrong-nonce" }
            : { issuer: "https://auth.openai.com", audience: config.clientId ?? client, nonce: callbackNonce };
      let jwt = new SignJWT({ email: "test@example.com", nonce: claims.nonce }).setProtectedHeader({ alg: "RS256", kid: "test-key" })
        .setIssuer(claims.issuer).setAudience(claims.audience).setSubject(config.subject ?? "subject-1").setIssuedAt();
      jwt = config.token === "expired" ? jwt.setExpirationTime(Math.floor(Date.now() / 1000) - 60) : jwt.setExpirationTime("5m");
      const idToken = await jwt.sign(config.token === "signature" ? otherKey : privateKey);
      const grantedScope = config.scope ?? scope;
      if (fields.get("grant_type") === "refresh_token") return JSON.stringify({ access_token: "access-rotated", refresh_token: "refresh-rotated", id_token: idToken, token_type: "Bearer", expires_in: 3600, scope: grantedScope });
      return JSON.stringify({ access_token: "access-secret-prefix", refresh_token: "refresh-1", id_token: idToken, token_type: "Bearer", expires_in: 3600, scope: grantedScope });
    }
    if (url === "https://auth.openai.com/revoke") { if (config.revokeFails) throw Error("sensitive revoke response body"); return "{}"; }
    if (url === "https://auth.openai.com/.well-known/openid-configuration") return JSON.stringify({ revocation_endpoint: "https://auth.openai.com/revoke" });
    throw Error(`Unexpected HTTP ${url}`);
  });
  return { root, store, auth: new ChatGptAuth(store, fetchMock as never), fetchMock, setNonce: (nonce: string) => { callbackNonce = nonce; } };
}
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe("ChatGPT OAuth", () => {
  it("generates fresh PKCE/state/nonce attempts, reuses the registered client, and stores private machine credentials", async () => {
    const f = await fixture();
    const first = await f.auth.startSignIn(account); const second = await f.auth.startSignIn(account);
    const a = new URL(first.url), b = new URL(second.url);
    expect(a.origin).toBe("https://auth.openai.com"); expect(a.pathname).toBe("/api/accounts/authorize");
    expect(a.searchParams.get("code_challenge_method")).toBe("S256");
    for (const key of ["state", "nonce", "code_challenge"]) expect(a.searchParams.get(key)).not.toBe(b.searchParams.get(key));
    expect(a.searchParams.get("resource")).toBe("https://api.openai.com/v1");
    first.cancel(); second.cancel();
    const mode = await stat(f.root); expect(mode.mode & 0o777).toBe(0o700);
    await expect(f.store.read("../../bad")).rejects.toMatchObject({ code: "invalid-account" });
  });

  it("rejects wrong callback state without token exchange and validates the signed identity on success", async () => {
    const f = await fixture(); const attempt = await f.auth.startSignIn(account); const authUrl = new URL(attempt.url);
    f.setNonce(authUrl.searchParams.get("nonce")!);
    const redirect = authUrl.searchParams.get("redirect_uri")!;
    const wrong = await fetch(`${redirect}?state=wrong&code=bad&client_id=${client}`);
    expect(wrong.status).toBe(400); expect(f.fetchMock).not.toHaveBeenCalled();
    const response = await fetch(`${redirect}?state=${authUrl.searchParams.get("state")}&code=code123&client_id=${client}`);
    expect(response.status).toBe(200);
    await expect(attempt.result).resolves.toEqual({ email: "test@example.com", firstSignIn: true });
    expect(f.fetchMock).toHaveBeenCalledWith("https://auth.openai.com/api/accounts/oauth/token", expect.objectContaining({ method: "POST" }));
    const saved = await f.store.read(account);
    expect(saved).toMatchObject({ clientId: client, subject: "subject-1", accessToken: "access-secret-prefix", refreshToken: "refresh-1" });
    expect(await stat(join(f.root, `${account}.json`)).then((value) => value.mode & 0o777)).toBe(0o600);
  });

  it.each(["signature", "issuer", "audience", "expired", "nonce"] as const)("rejects a signed identity with invalid %s and never returns token material", async (kind) => {
    const f = await fixture({ token: kind }); const attempt = await f.auth.startSignIn(account); const url = new URL(attempt.url);
    f.setNonce(url.searchParams.get("nonce")!);
    const callback = await fetch(`${url.searchParams.get("redirect_uri")}?state=${url.searchParams.get("state")}&code=code&client_id=${client}`);
    expect(callback.status).toBe(400);
    let caught: unknown;
    try { await attempt.result; } catch (error) { caught = error; }
    expect(caught).toMatchObject({ name: "ProviderRequestError" });
    expect(`${JSON.stringify(caught)} ${caught instanceof Error ? caught.message : ""}`).not.toMatch(/access-secret-prefix|refresh-1|private detail|token body/i);
    expect(await f.store.read(account)).toBeUndefined();
  });

  it.each(["openid profile email offline_access resource.invoke", "openid profile email offline_access chatgpt.tokens.use.direct"])("rejects plan consent missing a required usage scope", async (missingScope) => {
    const f = await fixture({ scope: missingScope }); const attempt = await f.auth.startSignIn(account); const url = new URL(attempt.url);
    f.setNonce(url.searchParams.get("nonce")!);
    const callback = await fetch(`${url.searchParams.get("redirect_uri")}?state=${url.searchParams.get("state")}&code=code&client_id=${client}`);
    expect(callback.status).toBe(400);
    await expect(attempt.result).rejects.toMatchObject({ code: "plan-permission", message: expect.not.stringMatching(/access-secret-prefix|refresh-1|private detail/i) });
    expect(await f.store.read(account)).toBeUndefined();
  });

  it.each(["missing", "mismatched"] as const)("rejects %s issued-client callback without exchanging", async (kind) => {
    const f = await fixture();
    if (kind === "mismatched") {
      const initial = await f.auth.startSignIn(account); const initialUrl = new URL(initial.url); f.setNonce(initialUrl.searchParams.get("nonce")!);
      await fetch(`${initialUrl.searchParams.get("redirect_uri")}?state=${initialUrl.searchParams.get("state")}&code=code&client_id=${client}`); await initial.result;
      f.fetchMock.mockClear();
    }
    const attempt = await f.auth.startSignIn(account); const url = new URL(attempt.url);
    const redirect = url.searchParams.get("redirect_uri")!; const state = url.searchParams.get("state")!;
    const clientQuery = kind === "missing" ? "" : "&client_id=oaiapp_other";
    const response = await fetch(`${redirect}?state=${state}&code=code${clientQuery}`); expect(response.status).toBe(400);
    expect(f.fetchMock).not.toHaveBeenCalled();
    await expect(attempt.result).rejects.toMatchObject({ code: "invalid-callback" });
  });

  it("rejects callback replay because the one-shot localhost listener closes", async () => {
    const f = await fixture(); const attempt = await f.auth.startSignIn(account); const url = new URL(attempt.url);
    f.setNonce(url.searchParams.get("nonce")!);
    const callbackUrl = `${url.searchParams.get("redirect_uri")}?state=${url.searchParams.get("state")}&code=code&client_id=${client}`;
    expect((await fetch(callbackUrl)).status).toBe(200); await attempt.result;
    await expect(fetch(callbackUrl)).rejects.toThrow();
  });

  it("does not overwrite a returning profile on verified subject mismatch", async () => {
    const f = await fixture();
    const signIn = async (subject: string) => {
      const attempt = await f.auth.startSignIn(account); const url = new URL(attempt.url); f.setNonce(url.searchParams.get("nonce")!);
      const response = await fetch(`${url.searchParams.get("redirect_uri")}?state=${url.searchParams.get("state")}&code=code&client_id=${client}`);
      if (subject === "subject-1") await attempt.result;
      return { attempt, response };
    };
    await signIn("subject-1");
    // Configure a valid JWT for a different account on the already registered client.
    const different = await fixture({ subject: "subject-2" });
    // Reuse the first store/account's current credentials, but an independent verifier fixture.
    const old = await f.store.read(account); await different.store.write(account, old!);
    const attempt = await different.auth.startSignIn(account); const url = new URL(attempt.url); different.setNonce(url.searchParams.get("nonce")!);
    const response = await fetch(`${url.searchParams.get("redirect_uri")}?state=${url.searchParams.get("state")}&code=code&client_id=${client}`);
    expect(response.status).toBe(400);
    await expect(attempt.result).rejects.toMatchObject({ code: "account-mismatch" });
    expect(await different.store.read(account)).toMatchObject({ subject: "subject-1", accessToken: "access-secret-prefix", refreshToken: "refresh-1" });
  });

  it("serializes refresh, persists rotated tokens, and sign-out retains registration but clears tokens", async () => {
    const f = await fixture(); const attempt = await f.auth.startSignIn(account); const url = new URL(attempt.url);
    f.setNonce(url.searchParams.get("nonce")!);
    await fetch(`${url.searchParams.get("redirect_uri")}?state=${url.searchParams.get("state")}&code=code&client_id=${client}`);
    await attempt.result;
    const saved = await f.store.read(account); await f.store.write(account, { ...saved!, expiresAt: 1 });
    const tokens = await Promise.all([f.auth.accessToken(account), f.auth.accessToken(account)]);
    expect(tokens).toEqual(["access-rotated", "access-rotated"]);
    expect(f.fetchMock.mock.calls.filter(([target]) => target.endsWith("/oauth/token"))).toHaveLength(2);
    await expect(f.auth.signOut(account)).resolves.toEqual({ revoked: true });
    expect(await f.store.read(account)).toMatchObject({ clientId: client, subject: "subject-1" });
    expect(await f.store.read(account)).not.toHaveProperty("accessToken");
    expect(await f.store.read(account)).not.toHaveProperty("refreshToken");
  });

  it("closes cancelled listeners and clears credentials even when remote revocation fails", async () => {
    const f = await fixture({ revokeFails: true }); const attempt = await f.auth.startSignIn(account); const url = new URL(attempt.url);
    f.setNonce(url.searchParams.get("nonce")!);
    await fetch(`${url.searchParams.get("redirect_uri")}?state=${url.searchParams.get("state")}&code=code&client_id=${client}`); await attempt.result;
    await expect(f.auth.signOut(account)).resolves.toEqual({ revoked: false });
    expect(await f.store.read(account)).toMatchObject({ clientId: client, subject: "subject-1" });
    expect(await f.store.read(account)).not.toHaveProperty("accessToken");
    const cancelled = await f.auth.startSignIn("c37a0123-4567-4234-9234-123456789abc");
    const redirect = new URL(cancelled.url).searchParams.get("redirect_uri")!; cancelled.cancel();
    await expect(cancelled.result).rejects.toMatchObject({ code: "cancelled" });
    await expect(fetch(`${redirect}?state=anything&code=code&client_id=${client}`)).rejects.toThrow();
  });
});
