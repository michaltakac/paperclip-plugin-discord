import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Company-scoped config bootstrap — issues #61, #72.
//
// Since paperclipai/paperclip#9557 (first stable in v2026.720.0) the SDK's
// governed-access gate requires a company scope for `config.get` and
// `secrets.resolve`; only `companies.list` is exempt. setup() runs outside any
// invocation, so a bare `ctx.config.get()` there throws and the worker dies on
// activation — which is exactly what every plugin used to do.
//
// These tests pin the behaviour on the three host generations the plugin has to
// survive. The gated host mock makes an unscoped `config.get()` THROW rather than
// return an empty object: a mock that quietly returns `{}` hides the bug (lesson
// from telegram #83).
// ---------------------------------------------------------------------------

const { capturedDefinitions } = vi.hoisted(() => {
  const capturedDefinitions: any[] = [];
  return { capturedDefinitions };
});

vi.mock("@paperclipai/plugin-sdk", () => ({
  definePlugin: (def: any) => {
    if (def.setup) capturedDefinitions.push(def);
    return Object.freeze({ definition: def });
  },
  runWorker: vi.fn(),
}));

const { gatewayConnects, gatewayCloses } = vi.hoisted(() => ({
  gatewayConnects: [] as Array<{ token: string }>,
  gatewayCloses: { count: 0 },
}));

vi.mock("../src/gateway.js", () => ({
  connectGateway: vi.fn(async (_ctx: any, token: string) => {
    gatewayConnects.push({ token });
    return { close: () => { gatewayCloses.count += 1; } };
  }),
}));

import { _resetRuntimeForTests, _getRuntimeForTests } from "../src/worker.js";
import { _resetCompanyIdCache } from "../src/company-resolver.js";

const COMPANY_A = "11111111-1111-1111-1111-111111111111";
const COMPANY_B = "22222222-2222-2222-2222-222222222222";
const SECRET_ID = "33333333-3333-3333-3333-333333333333";

/** Verbatim shape of the errors the governed host raises. */
const UNSCOPED_CONFIG_ERROR =
  'not allowed to perform "config.get": company context is required';
const SCOPED_CONFIG_DENIED =
  'not allowed to perform "config.get": company context is required';
const PRE_720_SECRET_KILL_SWITCH =
  "Plugin secret references are disabled on this host";

/** The stored config row the settings picker produces. */
function storedConfig(overrides: Record<string, unknown> = {}) {
  return {
    discordBotTokenRef: { type: "secret_ref", secretId: SECRET_ID, version: "latest" },
    defaultChannelId: "1490608926423646298",
    defaultGuildId: "",
    enableIntelligence: false,
    intelligenceChannelIds: [],
    enableEscalations: false,
    enableInbound: false,
    enableCommands: false,
    digestMode: "off",
    ...overrides,
  };
}

type HostOptions = {
  /** Companies `companies.list()` reports (it is exempt from the scope gate). */
  companies?: string[];
  /** `companies.list()` itself fails. */
  companiesThrow?: boolean;
  /** Stored config rows, by company id. A missing row models a fresh install. */
  rows?: Record<string, Record<string, unknown>>;
  /** A 720/722 host: even an explicitly scoped read is denied. */
  denyScopedConfig?: boolean;
  /** A pre-720 host: the secret-ref kill switch is still in place. */
  secretsKillSwitch?: boolean;
};

function buildHost(options: HostOptions = {}) {
  const {
    companies = [COMPANY_A],
    companiesThrow = false,
    rows = { [COMPANY_A]: storedConfig() },
    denyScopedConfig = false,
    secretsKillSwitch = false,
  } = options;

  const unscopedConfigReads: number[] = [];
  const stateStore = new Map<string, unknown>();

  const ctx = {
    config: {
      get: vi.fn(async (companyId?: string) => {
        if (!companyId) {
          // A governed host NEVER answers an unscoped read.
          unscopedConfigReads.push(1);
          throw new Error(UNSCOPED_CONFIG_ERROR);
        }
        if (denyScopedConfig) throw new Error(SCOPED_CONFIG_DENIED);
        return rows[companyId] ?? {};
      }),
    },
    secrets: {
      resolve: vi.fn(async () => {
        if (secretsKillSwitch) throw new Error(PRE_720_SECRET_KILL_SWITCH);
        return "discord-bot-token";
      }),
    },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    state: {
      get: vi.fn(async (key: any) => stateStore.get(`${key.scopeKind}:${key.scopeId ?? ""}:${key.stateKey}`) ?? null),
      set: vi.fn(async (key: any, value: unknown) => {
        stateStore.set(`${key.scopeKind}:${key.scopeId ?? ""}:${key.stateKey}`, value);
      }),
    },
    metrics: { write: vi.fn() },
    activity: { log: vi.fn() },
    jobs: { register: vi.fn() },
    tools: { register: vi.fn() },
    data: { register: vi.fn() },
    actions: { register: vi.fn() },
    events: { on: vi.fn(), emit: vi.fn(), subscribe: vi.fn() },
    companies: {
      list: vi.fn(async () => {
        if (companiesThrow) throw new Error("companies.list is unavailable");
        return companies.map((id) => ({ id, name: `Company ${id.slice(0, 4)}` }));
      }),
    },
    agents: { list: vi.fn(async () => []), invoke: vi.fn() },
    issues: { list: vi.fn(async () => []), get: vi.fn(async () => null), listComments: vi.fn(async () => []) },
    http: { fetch: vi.fn(async () => ({ ok: true, json: async () => ({}), text: async () => "" })) },
  } as any;

  return { ctx, unscopedConfigReads };
}

function definition(): any {
  return capturedDefinitions[capturedDefinitions.length - 1];
}

beforeEach(() => {
  _resetRuntimeForTests();
  _resetCompanyIdCache();
  gatewayConnects.length = 0;
  gatewayCloses.count = 0;
  vi.clearAllMocks();
});

describe("host matrix: pre-2026.720.0 (secret-ref kill switch)", () => {
  it("keeps the worker activated, degrades health, and reports the host's real error", async () => {
    const { ctx } = buildHost({ secretsKillSwitch: true });

    await expect(definition().setup(ctx)).resolves.toBeUndefined();

    expect(_getRuntimeForTests()).toBeNull();
    const diagnostics = await definition().onHealth();
    expect(diagnostics.status).toBe("degraded");
    expect(diagnostics.message).toContain(PRE_720_SECRET_KILL_SWITCH);
    expect(diagnostics.details).toMatchObject({ issue: "discord-bot-token-unresolved" });
  });
});

describe("host matrix: 2026.720.0 / 2026.722.0 (every scoped read denied)", () => {
  it("setup() completes and health is degraded, without the plugin reading config unscoped", async () => {
    const { ctx, unscopedConfigReads } = buildHost({ denyScopedConfig: true });

    await expect(definition().setup(ctx)).resolves.toBeUndefined();

    expect(unscopedConfigReads).toHaveLength(0);
    expect(ctx.config.get).not.toHaveBeenCalledWith();
    expect(_getRuntimeForTests()).toBeNull();
    expect((await definition().onHealth()).status).toBe("degraded");
  });

  it("bootstraps from the host's config delivery, with no worker restart", async () => {
    const { ctx } = buildHost({ denyScopedConfig: true });
    await definition().setup(ctx);
    expect(_getRuntimeForTests()).toBeNull();

    // The host delivers the stored config with its scope — the only path that
    // can start the runtime on this generation.
    await definition().onConfigChanged(storedConfig(), { companyId: COMPANY_A });

    const runtime = _getRuntimeForTests();
    expect(runtime?.companyId).toBe(COMPANY_A);
    expect(gatewayConnects).toHaveLength(1);
    expect(await definition().onHealth()).toEqual({ status: "ok" });
  });

  it("resolves the bot token with the company scope and the config path", async () => {
    const { ctx } = buildHost({ denyScopedConfig: true });
    await definition().setup(ctx);
    await definition().onConfigChanged(storedConfig(), { companyId: COMPANY_A });

    expect(ctx.secrets.resolve).toHaveBeenCalledWith(
      { type: "secret_ref", secretId: SECRET_ID, version: "latest" },
      { companyId: COMPANY_A, configPath: "discordBotTokenRef" },
    );
  });

  it("accepts a legacy bare-UUID secret reference too", async () => {
    const { ctx } = buildHost({ denyScopedConfig: true });
    await definition().setup(ctx);
    await definition().onConfigChanged(storedConfig({ discordBotTokenRef: SECRET_ID }), {
      companyId: COMPANY_A,
    });

    expect(_getRuntimeForTests()?.tokenSecretId).toBe(SECRET_ID);
    expect(ctx.secrets.resolve).toHaveBeenCalledWith(SECRET_ID, {
      companyId: COMPANY_A,
      configPath: "discordBotTokenRef",
    });
  });

  it("resolves a scope itself when the host delivers an instance-global save", async () => {
    const { ctx } = buildHost({ denyScopedConfig: true });
    await definition().setup(ctx);

    // companyId null = instance/global save. `secrets.resolve` still needs a scope.
    await definition().onConfigChanged(storedConfig(), { companyId: null });

    expect(_getRuntimeForTests()?.companyId).toBe(COMPANY_A);
    expect(ctx.secrets.resolve).toHaveBeenCalledWith(expect.anything(), {
      companyId: COMPANY_A,
      configPath: "discordBotTokenRef",
    });
  });
});

describe("host matrix: >= 2026.817.0 (proactive company scopes)", () => {
  it("starts the runtime from the startup walk during setup()", async () => {
    const { ctx, unscopedConfigReads } = buildHost();

    await definition().setup(ctx);

    expect(unscopedConfigReads).toHaveLength(0);
    expect(ctx.config.get).toHaveBeenCalledWith(COMPANY_A);
    expect(_getRuntimeForTests()?.companyId).toBe(COMPANY_A);
    expect(await definition().onHealth()).toEqual({ status: "ok" });
  });

  it("picks the first company that has a usable bot token", async () => {
    const { ctx } = buildHost({
      companies: [COMPANY_A, COMPANY_B],
      rows: {
        [COMPANY_A]: storedConfig({ discordBotTokenRef: "" }),
        [COMPANY_B]: storedConfig(),
      },
    });

    await definition().setup(ctx);

    expect(_getRuntimeForTests()?.companyId).toBe(COMPANY_B);
  });

  it("fresh install: the walk finds nothing, then a config save bootstraps it", async () => {
    const { ctx } = buildHost({ rows: {} });

    await definition().setup(ctx);
    expect(_getRuntimeForTests()).toBeNull();
    expect((await definition().onHealth()).status).toBe("degraded");

    await definition().onConfigChanged(storedConfig(), { companyId: COMPANY_A });

    expect(_getRuntimeForTests()?.companyId).toBe(COMPANY_A);
    expect(await definition().onHealth()).toEqual({ status: "ok" });
  });

  it("survives companies.list() failing outright", async () => {
    const { ctx } = buildHost({ companiesThrow: true });

    await expect(definition().setup(ctx)).resolves.toBeUndefined();
    expect(_getRuntimeForTests()).toBeNull();

    // and still bootstraps when the host delivers scoped config afterwards
    await definition().onConfigChanged(storedConfig(), { companyId: COMPANY_A });
    expect(_getRuntimeForTests()?.companyId).toBe(COMPANY_A);
  });
});

describe("re-bootstrap on configuration changes", () => {
  it("keeps the live gateway when the same company saves an unchanged token", async () => {
    const { ctx } = buildHost();
    await definition().setup(ctx);
    expect(gatewayConnects).toHaveLength(1);

    await definition().onConfigChanged(storedConfig({ defaultChannelId: "999999999999999999" }), {
      companyId: COMPANY_A,
    });

    expect(gatewayConnects).toHaveLength(1);
    expect(gatewayCloses.count).toBe(0);
    expect(_getRuntimeForTests()?.defaultChannelId).toBe("999999999999999999");
  });

  it("tears the gateway down and reconnects when the bot token changes", async () => {
    const { ctx } = buildHost();
    await definition().setup(ctx);
    ctx.secrets.resolve.mockResolvedValue("rotated-discord-bot-token");

    await definition().onConfigChanged(
      storedConfig({ discordBotTokenRef: { type: "secret_ref", secretId: "44444444-4444-4444-4444-444444444444" } }),
      { companyId: COMPANY_A },
    );

    expect(gatewayCloses.count).toBe(1);
    expect(gatewayConnects).toHaveLength(2);
    expect(gatewayConnects[1].token).toBe("rotated-discord-bot-token");
  });

  it("reconnects an unchanged token when the gateway failed permanently (#71)", async () => {
    const { ctx } = buildHost();
    await definition().setup(ctx);

    // Simulate the gateway giving up (fatal close code / identify budget).
    _getRuntimeForTests()!.gatewayFailed = true;

    await definition().onConfigChanged(storedConfig(), { companyId: COMPANY_A });

    expect(gatewayConnects).toHaveLength(2);
    expect(_getRuntimeForTests()?.gatewayFailed).toBe(false);
    expect(await definition().onHealth()).toEqual({ status: "ok" });
  });

  it("stays bound to the running company when another company's config arrives", async () => {
    const { ctx } = buildHost();
    await definition().setup(ctx);

    await definition().onConfigChanged(storedConfig(), { companyId: COMPANY_B });

    expect(_getRuntimeForTests()?.companyId).toBe(COMPANY_A);
    expect(gatewayConnects).toHaveLength(1);
    expect(ctx.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("already bound to a company"),
      expect.objectContaining({ runningCompanyId: COMPANY_A, deliveredCompanyId: COMPANY_B }),
    );
  });
});

describe("registration contract", () => {
  it("registers every handler during setup(), before any config is readable", async () => {
    const { ctx } = buildHost({ denyScopedConfig: true });

    await definition().setup(ctx);

    // The SDK requires registrations to complete synchronously within setup(),
    // so they cannot be gated on config the plugin is not allowed to read yet.
    const jobKeys = ctx.jobs.register.mock.calls.map((call: any[]) => call[0]);
    expect(jobKeys).toEqual(
      expect.arrayContaining([
        "check-escalation-timeouts",
        "check-budget-thresholds",
        "check-watches",
        "discord-daily-digest",
        "discord-intelligence-scan",
      ]),
    );

    const toolNames = ctx.tools.register.mock.calls.map((call: any[]) => call[0]);
    expect(toolNames).toEqual(
      expect.arrayContaining([
        "escalate_to_human",
        "handoff_to_agent",
        "discuss_with_agent",
        "register_custom_command",
        "register_watch",
        "discord_signals",
      ]),
    );

    const actionNames = ctx.actions.register.mock.calls.map((call: any[]) => call[0]);
    expect(actionNames).toEqual(expect.arrayContaining(["set-channel", "trigger-backfill"]));
  });

  it("tools answer with a clear not-configured error until the runtime exists", async () => {
    const { ctx } = buildHost({ denyScopedConfig: true });
    await definition().setup(ctx);

    const escalate = ctx.tools.register.mock.calls.find((call: any[]) => call[0] === "escalate_to_human")![2];
    const result = await escalate(
      { companyId: COMPANY_A, agentName: "agent", reason: "why" },
      { companyId: COMPANY_A },
    );

    expect(result.error).toMatch(/not configured yet/);
  });
});
