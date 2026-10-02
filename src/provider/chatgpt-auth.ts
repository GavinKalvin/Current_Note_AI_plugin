import { constants } from "node:fs";
import { mkdir, lstat, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";
import { createLocalJWKSet, jwtVerify, type JSONWebKeySet } from "jose";
import { chatGptFailure, chatGptHttp, type ChatGptHttp } from "./chatgpt-http";

const ISSUER = "https://auth.openai.com";
const TOKEN_ENDPOINT = `${ISSUER}/api/accounts/oauth/token`;
const RESOURCE = "https://api.openai.com/v1";
const SCOPES = "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct";
const REQUIRED_SCOPES = ["chatgpt.tokens.use.direct", "resource.invoke", "offline_access"];
export const CHATGPT_ACCOUNT_ID_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu;
interface Registration {
  clientId: string; subject: string; email: string; hostId: string; welcomed: boolean;
  accessToken?: string; refreshToken?: string; idToken?: string; expiresAt?: number; scopes?: string[];
}
type Tokens = { access_token?: unknown; refresh_token?: unknown; id_token?: unknown; token_type?: unknown; expires_in?: unknown; scope?: unknown };

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function isString(value: unknown): value is string { return typeof value === "string" && value.length > 0 && value.length < 64_000; }
function validClient(value: unknown): value is string { return typeof value === "string" && /^oaiapp_[a-zA-Z0-9_-]{1,200}$/u.test(value); }
function sameSecret(a: string, b: string): boolean {
  const x = Buffer.from(a); const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** Machine-local, owner-only storage. Never put OAuth credentials in the vault. */
export class ChatGptAuthStore {
  private queues = new Map<string, Promise<unknown>>();
  constructor(readonly root = join(homedir(), ".config", "current-note-ai", "chatgpt")) {}
  private path(id: string): string {
    if (!CHATGPT_ACCOUNT_ID_PATTERN.test(id)) throw chatGptFailure("invalid-account", "Create a ChatGPT profile before signing in.");
    return join(this.root, `${id.toLowerCase()}.json`);
  }
  private async prepare(): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const info = await lstat(this.root);
    if (!info.isDirectory() || info.isSymbolicLink() || (process.platform !== "win32" && (info.mode & 0o077))) {
      throw chatGptFailure("credential-storage", "ChatGPT credential directory must be private (0700) and not a symbolic link.");
    }
  }
  async read(id: string): Promise<Registration | undefined> {
    const path = this.path(id);
    await this.prepare();
    let file;
    try { file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)); }
    catch (error) {
      if (record(error).code === "ENOENT") return undefined;
      throw chatGptFailure("credential-storage", "Could not safely read ChatGPT credentials.");
    }
    try {
      const info = await file.stat();
      if (!info.isFile() || info.size > 256_000 || (process.platform !== "win32" && (info.mode & 0o077))) throw new Error();
      const data = record(JSON.parse(await file.readFile("utf8")));
      if (!validClient(data.clientId) || !isString(data.subject) || typeof data.email !== "string"
        || !/^urn:uuid:[a-f0-9-]{36}$/iu.test(String(data.hostId))) throw new Error();
      const credentials = [data.accessToken, data.refreshToken, data.idToken];
      if (credentials.some((value) => value !== undefined) && (!credentials.every(isString)
        || typeof data.expiresAt !== "number" || !Number.isFinite(data.expiresAt)
        || !Array.isArray(data.scopes) || !data.scopes.every((scope) => typeof scope === "string"))) throw new Error();
      return data as unknown as Registration;
    } catch { throw chatGptFailure("credential-storage", "ChatGPT credentials are unreadable or not private. Sign in again after fixing local storage."); }
    finally { await file.close(); }
  }
  async write(id: string, data: Registration): Promise<void> {
    await this.prepare();
    const path = this.path(id);
    const temporary = `${path}.${randomUUID()}.tmp`;
    try { await writeFile(temporary, JSON.stringify(data), { mode: 0o600, flag: "wx" }); await rename(temporary, path); }
    finally { await rm(temporary, { force: true }); }
  }
  async hostId(): Promise<string> {
    await this.prepare();
    const path = join(this.root, "host.json");
    const id = `urn:uuid:${randomUUID()}`;
    try { await writeFile(path, JSON.stringify({ id }), { mode: 0o600, flag: "wx" }); return id; }
    catch (error) { if (record(error).code !== "EEXIST") throw chatGptFailure("credential-storage", "Could not prepare the ChatGPT host identity."); }
    const info = await lstat(path);
    if (info.isSymbolicLink() || !info.isFile() || info.size > 1024) throw chatGptFailure("credential-storage", "Invalid local ChatGPT host identity.");
    const saved = record(JSON.parse(await readFile(path, "utf8")));
    if (!/^urn:uuid:[a-f0-9-]{36}$/iu.test(String(saved.id))) throw chatGptFailure("credential-storage", "Invalid local ChatGPT host identity.");
    return String(saved.id);
  }
  async exclusive<T>(id: string, action: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(id) ?? Promise.resolve();
    const result = previous.catch(() => undefined).then(async () => {
      await this.prepare();
      const lock = `${this.path(id)}.lock`;
      try { await mkdir(lock, { mode: 0o700 }); }
      catch { throw chatGptFailure("credential-busy", "Another plugin instance is updating this ChatGPT session. Try again when it finishes. A stale lock after a crash must be removed manually."); }
      try { return await action(); } finally { await rm(lock, { recursive: true, force: true }); }
    });
    this.queues.set(id, result);
    try { return await result; } finally { if (this.queues.get(id) === result) this.queues.delete(id); }
  }
}

export interface ChatGptSignInAttempt {
  url: string;
  result: Promise<{ email: string; firstSignIn: boolean }>;
  cancel(): void;
}
export function buildChatGptAuthorization(parameters: { hostId: string; redirectUri: string; state: string; nonce: string; verifier: string; clientId?: string }): string {
  const url = new URL(`${ISSUER}/api/accounts/authorize`);
  url.search = new URLSearchParams({
    client_id: parameters.clientId ?? "dynamic_agent_client", ext_agent_host_id: parameters.hostId,
    response_type: "code", redirect_uri: parameters.redirectUri, scope: SCOPES, resource: RESOURCE,
    state: parameters.state, nonce: parameters.nonce, code_challenge_method: "S256",
    code_challenge: createHash("sha256").update(parameters.verifier).digest("base64url"),
    ...(parameters.clientId ? {} : { agent_name_hint: "Current Note AI" }),
  }).toString();
  // No token hints in the displayed/copied URL. Returning sign-in uses the account selector.
  return url.toString();
}

export class ChatGptAuth {
  private jwks?: { fetchedAt: number; keys: JSONWebKeySet };
  constructor(readonly store = new ChatGptAuthStore(), private readonly http: ChatGptHttp = chatGptHttp) {}
  private async identity(idToken: string, clientId: string, nonce?: string): Promise<{ subject: string; email: string }> {
    const verify = async (force: boolean) => {
      if (force || !this.jwks || Date.now() - this.jwks.fetchedAt > 3_600_000) {
        this.jwks = { fetchedAt: Date.now(), keys: JSON.parse(await this.http(`${ISSUER}/.well-known/jwks.json`)) as JSONWebKeySet };
      }
      return jwtVerify(idToken, createLocalJWKSet(this.jwks.keys), {
        issuer: ISSUER, audience: clientId, requiredClaims: ["sub", "exp", "iat"], clockTolerance: 5,
      });
    };
    try {
      let verified;
      try { verified = await verify(false); }
      catch (error) { if (record(error).code !== "ERR_JWKS_NO_MATCHING_KEY") throw error; verified = await verify(true); }
      const { payload } = verified;
      if (!isString(payload.sub) || (nonce !== undefined && payload.nonce !== nonce)) throw new Error();
      return { subject: payload.sub, email: typeof payload.email === "string" ? payload.email.slice(0, 320) : "ChatGPT account" };
    } catch { throw chatGptFailure("identity-verification", "ChatGPT sign-in identity could not be verified. No credentials were replaced."); }
  }
  private tokens(raw: Tokens, previous?: Registration): Pick<Registration, "accessToken" | "refreshToken" | "idToken" | "expiresAt" | "scopes"> {
    const scopes = typeof raw.scope === "string" ? raw.scope.split(/\s+/u).filter(Boolean) : previous?.scopes;
    if (!isString(raw.access_token) || !isString(raw.refresh_token ?? previous?.refreshToken)
      || !isString(raw.id_token ?? previous?.idToken) || String(raw.token_type).toLowerCase() !== "bearer"
      || typeof raw.expires_in !== "number" || !Number.isFinite(raw.expires_in) || raw.expires_in <= 0
      || !scopes || !REQUIRED_SCOPES.every((scope) => scopes.includes(scope))) {
      throw chatGptFailure("plan-permission", "ChatGPT plan usage was not granted. Continue with ChatGPT and approve plan usage; identity-only login is insufficient.");
    }
    return { accessToken: raw.access_token, refreshToken: String(raw.refresh_token ?? previous?.refreshToken),
      idToken: String(raw.id_token ?? previous?.idToken), scopes, expiresAt: Date.now() + raw.expires_in * 1000 };
  }
  private async exchange(values: Record<string, string>): Promise<Tokens> {
    try { return JSON.parse(await this.http(TOKEN_ENDPOINT, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ ...values, resource: RESOURCE }).toString() })) as Tokens; }
    catch (error) { if (record(error).name === "ProviderRequestError") throw error; throw chatGptFailure("invalid-response", "OpenAI returned an invalid sign-in response."); }
  }
  async accessToken(id: string, signal?: AbortSignal): Promise<string> {
    return this.store.exclusive(id, async () => {
      if (signal?.aborted) throw chatGptFailure("cancelled", "ChatGPT request cancelled.");
      let saved = await this.store.read(id);
      if (!saved?.accessToken || !saved.refreshToken || !saved.scopes || !REQUIRED_SCOPES.every((scope) => saved!.scopes!.includes(scope))) {
        throw chatGptFailure("authentication", "Open plugin settings and Continue with ChatGPT. A separate authorization is required; Codex login and API keys are not reused.");
      }
      if ((saved.expiresAt ?? 0) <= Date.now() + 60_000) {
        let raw: Tokens;
        try { raw = await this.exchange({ grant_type: "refresh_token", client_id: saved.clientId, refresh_token: saved.refreshToken }); }
        catch (error) {
          if (record(error).code === "refresh-expired") {
            const { clientId, subject, email, hostId, welcomed } = saved;
            await this.store.write(id, { clientId, subject, email, hostId, welcomed });
          }
          throw error;
        }
        const replacement = this.tokens(raw, saved);
        if (isString(raw.id_token)) {
          const identity = await this.identity(raw.id_token, saved.clientId);
          if (identity.subject !== saved.subject) throw chatGptFailure("account-mismatch", "ChatGPT refreshed a different account. Credentials were not replaced.");
        }
        saved = { ...saved, ...replacement };
        await this.store.write(id, saved);
      }
      if (signal?.aborted) throw chatGptFailure("cancelled", "ChatGPT request cancelled.");
      return saved.accessToken!;
    });
  }
  async startSignIn(id: string): Promise<ChatGptSignInAttempt> {
    const saved = await this.store.read(id);
    const hostId = await this.store.hostId();
    const state = randomBytes(32).toString("base64url");
    const nonce = randomBytes(32).toString("base64url");
    const verifier = randomBytes(64).toString("base64url");
    let resolve!: (value: { email: string; firstSignIn: boolean }) => void;
    let reject!: (error: Error) => void;
    const result = new Promise<{ email: string; firstSignIn: boolean }>((a, b) => { resolve = a; reject = b; });
    // UI installs its own handler later; prevent cancellation from becoming an unhandled rejection.
    void result.catch(() => undefined);
    let consumed = false;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let redirectUri = "";
    const server = createServer((req, res) => {
      res.setHeader("Cache-Control", "no-store"); res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.setHeader("Content-Security-Policy", "default-src 'none'");
      let callback: URL;
      try { callback = new URL(req.url ?? "", redirectUri); }
      catch { res.writeHead(400); res.end("Invalid callback."); return; }
      if (req.method !== "GET" || callback.origin !== new URL(redirectUri).origin || callback.pathname !== "/auth/callback" || consumed
        || ["state", "code", "client_id", "error"].some((name) => callback.searchParams.getAll(name).length > 1)
        || !sameSecret(callback.searchParams.get("state") ?? "", state)) {
        res.writeHead(400); res.end("Sign-in callback could not be verified."); return;
      }
      consumed = true;
      if (timer) clearTimeout(timer);
      const complete = async () => {
        if (callback.searchParams.has("error")) throw chatGptFailure("consent-denied", "ChatGPT sign-in or plan permission was declined. You can try again in plugin settings.");
        const clientId = callback.searchParams.get("client_id") ?? saved?.clientId;
        const code = callback.searchParams.get("code");
        if (!validClient(clientId) || !code || code.length > 16_384 || (saved && clientId !== saved.clientId)) {
          throw chatGptFailure("invalid-callback", "ChatGPT registration was incomplete or did not match the selected account.");
        }
        const raw = await this.exchange({ grant_type: "authorization_code", client_id: clientId, code, code_verifier: verifier, redirect_uri: redirectUri });
        const credentials = this.tokens(raw);
        const identity = await this.identity(credentials.idToken!, clientId, nonce);
        if (saved && identity.subject !== saved.subject) throw chatGptFailure("account-mismatch", "This is a different ChatGPT account. Add another profile to sign in with it.");
        await this.store.exclusive(id, async () => {
          if (cancelled) throw chatGptFailure("cancelled", "ChatGPT sign-in cancelled. Credentials were not replaced.");
          const current = await this.store.read(id);
          if (current && (current.clientId !== clientId || current.subject !== identity.subject)) {
            throw chatGptFailure("account-mismatch", "Another sign-in registered a different account for this profile. Add another profile instead of replacing it.");
          }
          await this.store.write(id, { clientId, ...identity, hostId, welcomed: true, ...credentials });
        });
        return { email: identity.email, firstSignIn: !saved?.welcomed };
      };
      void complete().then((value) => { res.end("ChatGPT plan connected. You can return to Obsidian and close this tab."); resolve(value); }, (error) => {
        res.writeHead(400); res.end("ChatGPT sign-in failed. Return to Obsidian for details.");
        reject(error instanceof Error && record(error).name === "ProviderRequestError" ? error : chatGptFailure("sign-in-failed", "ChatGPT sign-in failed. No credentials were replaced."));
      }).finally(() => server.close());
    });
    await new Promise<void>((done, fail) => {
      const error = () => fail(chatGptFailure("callback-listener", "Could not start the local ChatGPT callback listener."));
      server.once("error", error);
      server.listen(0, "127.0.0.1", () => { server.removeListener("error", error); done(); });
    });
    server.on("error", () => reject(chatGptFailure("callback-listener", "The local ChatGPT callback listener failed.")));
    const address = server.address();
    if (!address || typeof address === "string") { server.close(); throw chatGptFailure("callback-listener", "Invalid local callback address."); }
    redirectUri = `http://127.0.0.1:${address.port}/auth/callback`;
    const cancel = () => {
      cancelled = true; consumed = true;
      if (timer) clearTimeout(timer);
      server.closeAllConnections(); server.close();
      reject(chatGptFailure("cancelled", "ChatGPT sign-in cancelled or expired. Start again in plugin settings."));
    };
    timer = setTimeout(cancel, 5 * 60_000);
    return { url: buildChatGptAuthorization({ hostId, redirectUri, state, nonce, verifier, clientId: saved?.clientId }), result, cancel };
  }
  async accountInfo(id: string): Promise<{ email: string; signedIn: boolean }> {
    const saved = await this.store.read(id);
    return { email: saved?.email ?? "Not signed in", signedIn: !!saved?.accessToken };
  }
  async signOut(id: string): Promise<{ revoked: boolean }> {
    return this.store.exclusive(id, async () => {
      const saved = await this.store.read(id);
      if (!saved) return { revoked: true };
      let revoked = !saved.refreshToken;
      if (saved.refreshToken) {
        try {
          const discovery = record(JSON.parse(await this.http(`${ISSUER}/.well-known/openid-configuration`)));
          const endpoint = new URL(String(discovery.revocation_endpoint));
          if (endpoint.origin !== ISSUER || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) throw new Error();
          await this.http(endpoint.toString(), { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ token: saved.refreshToken, token_type_hint: "refresh_token", client_id: saved.clientId }).toString() });
          revoked = true;
        } catch { /* Clear local tokens even if remote revocation cannot be confirmed. */ }
      }
      const { clientId, subject, email, hostId, welcomed } = saved;
      await this.store.write(id, { clientId, subject, email, hostId, welcomed });
      return { revoked };
    });
  }
}

export const chatGptAuth = new ChatGptAuth();
export const startChatGptSignIn = (id: string): Promise<ChatGptSignInAttempt> => chatGptAuth.startSignIn(id);
export const getChatGptAccountInfo = (id: string): Promise<{ email: string; signedIn: boolean }> => chatGptAuth.accountInfo(id);
export const signOutChatGpt = (id: string): Promise<{ revoked: boolean }> => chatGptAuth.signOut(id);
