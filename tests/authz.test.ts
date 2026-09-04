import { describe, it, expect, vi } from "vitest";
import { handleInteraction, isPrivilegedActor, type CommandContext } from "../src/commands.js";

// ---------------------------------------------------------------------------
// Privileged-command gating.
//
// Without this, ANY member of the guild can approve Paperclip approvals,
// import and run workflows (which invoke agents, create issues and make
// outbound HTTP calls), and reconfigure company/channel routing.
// ---------------------------------------------------------------------------

function ctx() {
  return {
    metrics: { write: vi.fn().mockResolvedValue(undefined) },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    state: { get: vi.fn().mockResolvedValue(null), set: vi.fn().mockResolvedValue(undefined) },
    agents: { list: vi.fn().mockResolvedValue([]) },
    issues: { list: vi.fn().mockResolvedValue([]) },
    companies: { list: vi.fn().mockResolvedValue([]) },
  } as any;
}

const RESTRICTED = { baseUrl: "https://pc.test", token: "t", adminUserIds: ["admin-1"], adminRoleIds: ["role-9"] } as unknown as CommandContext;
const OPEN = { baseUrl: "https://pc.test", token: "t" } as unknown as CommandContext;

function clip(sub: string, member: any) {
  return { type: 2, data: { name: "clip", options: [{ name: sub, options: [] }] }, member };
}
const stranger = { user: { id: "nobody", username: "stranger" }, roles: [] };
const admin = { user: { id: "admin-1", username: "boss" }, roles: [] };
const byRole = { user: { id: "someone", username: "lead" }, roles: ["role-9"] };

describe("isPrivilegedActor", () => {
  it("is open when no lists are configured (historical behaviour)", () => {
    expect(isPrivilegedActor(stranger, OPEN)).toBe(true);
  });
  it("matches on user id or role id", () => {
    expect(isPrivilegedActor(admin, RESTRICTED)).toBe(true);
    expect(isPrivilegedActor(byRole, RESTRICTED)).toBe(true);
  });
  it("refuses everyone else once configured", () => {
    expect(isPrivilegedActor(stranger, RESTRICTED)).toBe(false);
    expect(isPrivilegedActor(undefined, RESTRICTED)).toBe(false);
  });
});

describe("command gating", () => {
  for (const sub of ["approve", "commands", "connect", "connect-channel", "digest"]) {
    it(`blocks /clip ${sub} for a non-operator`, async () => {
      const res: any = await handleInteraction(ctx(), clip(sub, stranger), RESTRICTED);
      expect(JSON.stringify(res)).toMatch(/restricted to this server's Paperclip operators/);
    });
  }

  it("allows an operator through", async () => {
    const res: any = await handleInteraction(ctx(), clip("connect", admin), RESTRICTED);
    expect(JSON.stringify(res)).not.toMatch(/restricted to this server/);
  });

  it("never blocks read-only or per-user commands", async () => {
    // Blocking these would make the plugin useless for ordinary members.
    for (const sub of ["status", "issues", "agents", "help", "whoami", "link"]) {
      const res: any = await handleInteraction(ctx(), clip(sub, stranger), RESTRICTED);
      expect(JSON.stringify(res), sub).not.toMatch(/restricted to this server/);
    }
  });
});
