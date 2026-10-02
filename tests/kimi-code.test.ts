import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  buildKimiCodeAgent, KIMI_CODE_MODEL, KIMI_CODE_MODEL_ALIAS, KimiCodeAdapter,
  parseKimiCodeJournal, parseKimiCodeOutput, runKimiProcess, type CliRunOptions, type CliRunner,
} from "../src/provider/kimi-code";

let home: string;
let oldHome: string | undefined;
const request = (model = KIMI_CODE_MODEL, messages = [{ role: "user" as const, content: "hello" }]) => ({
  messages, options: { model, maxTokens: 1024, temperature: 0, responseFormat: "text" as const },
});
const membership = { providers: { "managed:kimi-code": { type: "kimi", baseUrl: "https://api.kimi.com/coding/v1", apiKey: "", oauth: { account: "fixture" } } }, models: {
  [KIMI_CODE_MODEL_ALIAS]: { provider: "managed:kimi-code", model: KIMI_CODE_MODEL },
} };
const goodJournal = JSON.stringify({ type: "profile.bind", modelAlias: KIMI_CODE_MODEL_ALIAS, activeToolNames: [] }) + "\n"
  + JSON.stringify({ event: { type: "step.end", finishReason: "stop" } }) + "\n"
  + JSON.stringify({ type: "usage.record", usage: { inputTokens: 12, outputTokens: 8, reasoningTokens: 2 } }) + "\n";

function runner(options: { list?: unknown; completion?: string; exitCode?: number; stderr?: string; journal?: string } = {}) {
  const calls: Array<{ args: readonly string[]; opts: CliRunOptions }> = [];
  let agentFile = "";
  const run: CliRunner = async (_exe, args, opts) => {
    calls.push({ args, opts });
    if (args[0] === "--version") return { stdout: "kimi 0.36.1\n", stderr: "", exitCode: 0 };
    if (args[0] === "provider") return { stdout: JSON.stringify(options.list ?? membership), stderr: "", exitCode: 0 };
    agentFile = await readFile(args[args.indexOf("--agent-file") + 1]!, "utf8");
    if (options.journal) {
      const id = "session_fixture-123";
      const path = join(home, "sessions", "bucket", id, "agents", "main");
      await mkdir(path, { recursive: true });
      await writeFile(join(path, "wire.jsonl"), options.journal, { mode: 0o600 });
    }
    const defaultOutput = `{"role":"assistant","content":"answer"}\n${options.journal ? '{"type":"session.resume_hint","session_id":"session_fixture-123"}\n' : ""}`;
    return { stdout: options.completion ?? defaultOutput, stderr: options.stderr ?? "", exitCode: options.exitCode ?? 0 };
  };
  return { run, calls, get agentFile() { return agentFile; } };
}

beforeEach(async () => {
  oldHome = process.env.KIMI_CODE_HOME;
  home = await mkdtemp(join(tmpdir(), "cnai-kimi-test-"));
  process.env.KIMI_CODE_HOME = home;
  await writeFile(join(home, "config.toml"), "");
  await mkdir(join(home, "plugins"), { recursive: true });
  await writeFile(join(home, "plugins", "installed.json"), '{"plugins":[]}');
  await writeFile(join(home, "mcp.json"), '{"mcpServers":{}}');
});
afterEach(async () => {
  if (oldHome === undefined) delete process.env.KIMI_CODE_HOME; else process.env.KIMI_CODE_HOME = oldHome;
  await rm(home, { recursive: true, force: true });
});

describe("Kimi Code local-membership adapter", () => {
  it("offers only the explicit K3-256k OAuth membership model", async () => {
    const f = runner();
    await expect(new KimiCodeAdapter("/fixture/kimi", f.run).listModels("")).resolves.toEqual([
      { id: KIMI_CODE_MODEL, ownedBy: "Kimi Code membership", contextWindowTokens: 262144 },
    ]);
    await expect(new KimiCodeAdapter("/fixture/kimi", f.run).complete("ignored", request("other"))).rejects.toMatchObject({ code: "unsupported-model" });
    expect(f.calls).toHaveLength(2); // model rejection occurs before CLI invocation
    expect(f.calls.every(({ args }) => !args.includes("--api-key"))).toBe(true);
  });

  it("does not accept API-only or mismatched local provider configuration", async () => {
    const f = runner({ list: { providers: { "managed:kimi-code": { ...membership.providers["managed:kimi-code"], oauth: {} } }, models: membership.models } });
    await expect(new KimiCodeAdapter("/fixture/kimi", f.run).listModels("")).rejects.toMatchObject({ code: "subscription-required" });
  });

  it.each([
    ["custom endpoint", { baseUrl: "https://proxy.invalid/coding/v1" }],
    ["plaintext API key", { apiKey: "fixture-api-key" }],
    ["API key environment reference", { apiKeyEnv: "KIMI_API_KEY" }],
  ])("blocks %s even when Kimi OAuth is present", async (_label, override) => {
    const provider = { ...membership.providers["managed:kimi-code"], ...override };
    const f = runner({ list: { providers: { "managed:kimi-code": provider }, models: membership.models } });
    await expect(new KimiCodeAdapter("/fixture/kimi", f.run).listModels("")).rejects.toMatchObject({ code: "subscription-required" });
  });

  it("builds a tool-free agent and keeps dollar/template-like note data literal", () => {
    const agent = buildKimiCodeAgent(request(KIMI_CODE_MODEL, [{ role: "user", content: "${cwd} ${agents_md} ${base_prompt} $env and \"quotes\"" }]));
    expect(agent).toContain("tools: []\nsubagents: []");
    expect(agent).toContain("\\u0024{cwd}");
    expect(agent).toContain("\\u0024{agents_md}");
    expect(agent).toContain("\\u0024{base_prompt}");
    expect(agent).not.toContain("${cwd}");
  });

  it("passes only the fixed alias and isolated agent/skills paths, never note text in argv", async () => {
    const f = runner({ journal: goodJournal });
    await new KimiCodeAdapter("/fixture/kimi", f.run).complete("", request(KIMI_CODE_MODEL, [{ role: "user", content: "private-note-value" }]));
    const call = f.calls.at(-1)!;
    expect(call.args).toContain(KIMI_CODE_MODEL_ALIAS);
    expect(call.args).toContain("--agent-file");
    expect(call.args).toContain("--skills-dir");
    expect(call.args.join(" ")).not.toContain("private-note-value");
    expect(call.opts.cwd).not.toBe(home);
    expect(call.opts.cwd).toContain("current-note-ai-kimi-");
    expect(f.agentFile).toContain("private-note-value");
  });

  it.each(["broken json", '{"role":"tool","content":"secret"}', '{"tool_calls":[{"id":"x"}]}'])("rejects malformed or tool-bearing stream rows", (line) => {
    expect(() => parseKimiCodeOutput(`${line}\n`)).toThrow();
  });

  it("accepts only the plugin's own session ID shape", () => {
    expect(parseKimiCodeOutput('{"type":"session.resume_hint","session_id":"session_ok-12"}').sessionId).toBe("session_ok-12");
    expect(parseKimiCodeOutput('{"type":"session.resume_hint","session_id":"../../other"}').sessionId).toBeUndefined();
  });

  it("parses the verified step stop, truncation, and usage metadata", () => {
    expect(parseKimiCodeJournal(goodJournal)).toEqual({ finishReason: "stop", usage: {
      promptTokens: 12, completionTokens: 8, reasoningTokens: 2, totalTokens: 20,
    } });
    const truncated = JSON.stringify({ type: "profile.bind", modelAlias: KIMI_CODE_MODEL_ALIAS, activeToolNames: [] }) + "\n"
      + JSON.stringify({ event: { type: "turn.step.completed", rawFinishReason: "max_tokens" } });
    expect(parseKimiCodeJournal(truncated).finishReason).toBe("length");
  });

  it("keeps missing or unbound journal metadata unknown", () => {
    expect(parseKimiCodeJournal(JSON.stringify({ event: { type: "step.end", finishReason: "stop" } })).finishReason).toBe("unknown");
    expect(parseKimiCodeJournal(JSON.stringify({ type: "profile.bind", modelAlias: KIMI_CODE_MODEL_ALIAS, activeToolNames: [] })).finishReason).toBe("unknown");
  });

  it("rejects a journal binding that enables tools or a different model", () => {
    for (const row of [
      { type: "profile.bind", modelAlias: "kimi-code/other", activeToolNames: [] },
      { type: "profile.bind", modelAlias: KIMI_CODE_MODEL_ALIAS, activeToolNames: ["shell"] },
    ]) expect(() => parseKimiCodeJournal(JSON.stringify(row))).toThrow();
  });

  it("blocks enabled hooks, plugins, and MCP servers from the isolated CLI home", async () => {
    const f = runner();
    await writeFile(join(home, "config.toml"), "[hooks]\nbefore = 'echo unsafe'\n");
    await expect(new KimiCodeAdapter("/fixture/kimi", f.run).listModels("")).rejects.toMatchObject({ code: "unsafe-cli-config" });
    await writeFile(join(home, "config.toml"), "");
    await writeFile(join(home, "plugins", "installed.json"), '{"plugins":[{"enabled":true}]}');
    await expect(new KimiCodeAdapter("/fixture/kimi", f.run).listModels("")).rejects.toMatchObject({ code: "unsafe-cli-config" });
    await writeFile(join(home, "plugins", "installed.json"), '{"plugins":[]}');
    await writeFile(join(home, "mcp.json"), '{"mcpServers":{"remote":{"enabled":true}}}');
    await expect(new KimiCodeAdapter("/fixture/kimi", f.run).listModels("")).rejects.toMatchObject({ code: "unsafe-cli-config" });
    expect(f.calls).toHaveLength(0);
  });

  it("clears ambient model/API/Node overrides and applies a bounded request budget", async () => {
    const prior = Object.fromEntries(["KIMI_MODEL_CUSTOM", "KIMI_CODE_BASE_URL", "KIMI_CODE_OAUTH_TOKEN", "KIMI_OAUTH_HOST", "NODE_OPTIONS"].map((key) => [key, process.env[key]]));
    Object.assign(process.env, { KIMI_MODEL_CUSTOM: "secret-marker", KIMI_CODE_BASE_URL: "https://invalid", KIMI_CODE_OAUTH_TOKEN: "secret-marker", KIMI_OAUTH_HOST: "https://invalid", NODE_OPTIONS: "--require=unsafe" });
    try {
      const f = runner();
      await new KimiCodeAdapter("/fixture/kimi", f.run).complete("", request());
      const env = f.calls.at(-1)!.opts.env;
      expect(env.KIMI_MODEL_CUSTOM).toBeUndefined();
      expect(env.KIMI_CODE_BASE_URL).toBeUndefined();
      expect(env.KIMI_CODE_OAUTH_TOKEN).toBeUndefined();
      expect(env.KIMI_OAUTH_HOST).toBeUndefined();
      expect(env.NODE_OPTIONS).toBeUndefined();
      expect(env.KIMI_MODEL_MAX_COMPLETION_TOKENS).toBe("1024");
      expect(env.KIMI_DISABLE_TELEMETRY).toBe("1");
    } finally { for (const [key, value] of Object.entries(prior)) value === undefined ? delete process.env[key] : process.env[key] = value; }
  });

  it("maps quota/authentication failures without exposing CLI diagnostics or API fallback", async () => {
    for (const [stderr, code] of [["429 quota SECRET", "quota"], ["401 unauthorized SECRET", "authentication"]]) {
      const f = runner({ exitCode: 1, stderr });
      await expect(new KimiCodeAdapter("/fixture/kimi", f.run).complete("", request())).rejects.toMatchObject({ code });
      expect(f.calls.at(-1)!.args).toContain("--model");
    }
  });

  it("cancels a real local child process", async () => {
    const controller = new AbortController();
    const running = runKimiProcess(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      cwd: tmpdir(), env: process.env, signal: controller.signal, timeoutMs: 900,
    });
    await delay(40);
    controller.abort();
    await expect(running).rejects.toMatchObject({ code: "cancelled" });
  });

  it("times out and stops a real local child process within the test bound", async () => {
    await expect(runKimiProcess(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      cwd: tmpdir(), env: process.env, timeoutMs: 80,
    })).rejects.toMatchObject({ code: "timeout" });
  });

  it("preserves UTF-8 characters written across separate child-process chunks", async () => {
    const result = await runKimiProcess(process.execPath, ["-e", "process.stdout.write(Buffer.from([0xe4])); setTimeout(() => process.stdout.write(Buffer.from([0xb8, 0xad])), 10)"], {
      cwd: tmpdir(), env: process.env, timeoutMs: 800,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("中");
  });

  it("removes the isolated workspace after a successful completion", async () => {
    let isolatedCwd = "";
    const fake: CliRunner = async (_exe, args, options) => {
      isolatedCwd = options.cwd;
      if (args[0] === "--version") return { stdout: "kimi 0.36.1", stderr: "", exitCode: 0 };
      if (args[0] === "provider") return { stdout: JSON.stringify(membership), stderr: "", exitCode: 0 };
      return { stdout: '{"role":"assistant","content":"ok"}', stderr: "", exitCode: 0 };
    };
    await expect(new KimiCodeAdapter("/fixture/kimi", fake).complete("", request())).resolves.toMatchObject({ content: "ok" });
    await expect(readFile(join(isolatedCwd, "note-assistant.md"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a non-absolute CLI path before invoking the runner", async () => {
    let called = false;
    const fake: CliRunner = async () => { called = true; return { stdout: "", stderr: "", exitCode: 0 }; };
    await expect(new KimiCodeAdapter("kimi", fake).listModels("")).rejects.toMatchObject({ code: "invalid-cli-path" });
    expect(called).toBe(false);
  });
});
