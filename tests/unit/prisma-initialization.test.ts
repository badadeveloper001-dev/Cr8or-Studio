import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  client: { $connect: vi.fn() },
  construct: vi.fn(),
  execSync: vi.fn(),
  exec: vi.fn(),
  spawn: vi.fn(),
}));

vi.mock("@prisma/client", () => ({
  PrismaClient: class {
    constructor(options: unknown) {
      mocks.construct(options);
      return mocks.client;
    }
  },
}));
vi.mock("node:child_process", () => ({ execSync: mocks.execSync, exec: mocks.exec, spawn: mocks.spawn }));

describe("Prisma initialization", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    delete globalThis.prismaGlobal;
  });

  afterEach(() => {
    delete globalThis.prismaGlobal;
    vi.unstubAllEnvs();
  });

  it("constructs the production client without shell commands or connecting", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("DATABASE_URL", "postgresql://unused:unused@127.0.0.1:1/unused");
    const { prisma } = await import("@/lib/db/prisma");
    expect(prisma).toBe(mocks.client);
    expect(mocks.construct).toHaveBeenCalledOnce();
    expect(mocks.construct).toHaveBeenCalledWith({ log: ["warn"] });
    expect(mocks.execSync).not.toHaveBeenCalled();
    expect(mocks.exec).not.toHaveBeenCalled();
    expect(mocks.spawn).not.toHaveBeenCalled();
    expect(mocks.client.$connect).not.toHaveBeenCalled();
    expect(globalThis.prismaGlobal).toBeUndefined();
  });

  it("reuses the development client across module reloads", async () => {
    vi.stubEnv("NODE_ENV", "development");
    const first = await import("@/lib/db/prisma");
    vi.resetModules();
    const second = await import("@/lib/db/prisma");
    expect(first.prisma).toBe(second.prisma);
    expect(globalThis.prismaGlobal).toBe(first.prisma);
    expect(mocks.construct).toHaveBeenCalledOnce();
    expect(mocks.client.$connect).not.toHaveBeenCalled();
  });
});
