import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import type { PrismaClient } from "../../src/generated/prisma/client";
import { getDb } from "../../src/server/db";
import { scratchDatabase } from "./scratch";

const { prisma } = scratchDatabase();
let db: PrismaClient;

afterAll(async () => {
  await db?.$disconnect();
});

describe("migrations", () => {
  it("apply to an empty database", () => {
    expect(prisma("migrate", "deploy")).toMatch(/successfully applied/);
  });

  it("are safe to deploy again", () => {
    expect(prisma("migrate", "deploy")).toMatch(/No pending migrations/);
  });

  it("leave no drift from schema.prisma", () => {
    // --exit-code: 0 = no difference, 2 = difference (execFileSync throws).
    expect(prisma("migrate", "diff", "--from-config-datasource", "--to-schema", "prisma/schema.prisma", "--exit-code")).toMatch(
      /No difference/,
    );
  });

  it("create the expected tables and indexes", async () => {
    db = getDb();
    const tables = await db.$queryRaw<{ table_name: string }[]>`
      SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name`;
    expect(tables.map((t) => t.table_name)).toEqual([
      "_prisma_migrations",
      "account",
      "project",
      "rateLimit",
      "reconciliation_snapshot",
      "session",
      "user",
      "verification",
      "workspace",
    ]);
    const indexes = await db.$queryRaw<{ indexname: string }[]>`
      SELECT indexname FROM pg_indexes WHERE schemaname = 'public' AND tablename IN ('workspace', 'project', 'reconciliation_snapshot')`;
    expect(indexes.map((i) => i.indexname)).toEqual(
      expect.arrayContaining([
        "workspace_ownerId_key",
        "project_workspaceId_updatedAt_idx",
        "reconciliation_snapshot_projectId_version_key",
        "reconciliation_snapshot_projectId_idempotencyKey_key",
        "reconciliation_snapshot_projectId_createdAt_idx",
      ]),
    );
    const audit = await db.$queryRaw<{ data_type: string }[]>`
      SELECT data_type FROM information_schema.columns WHERE table_name = 'reconciliation_snapshot' AND column_name = 'audit'`;
    expect(audit).toEqual([{ data_type: "jsonb" }]);
  });
});

describe("constraints", () => {
  const user = async () => getDb().user.create({ data: { id: randomUUID(), name: "Synthetic", email: `${randomUUID()}@example.test` } });
  const project = async () => {
    const owner = await user();
    const workspace = await getDb().workspace.create({ data: { ownerId: owner.id, name: "Personal" } });
    return getDb().project.create({ data: { workspaceId: workspace.id, name: "Synthetic project" } });
  };
  const snapshot = (projectId: string, version: number, idempotencyKey = randomUUID()) =>
    getDb().reconciliationSnapshot.create({
      data: {
        projectId,
        version,
        idempotencyKey,
        audit: { schemaVersion: 1, synthetic: true },
        auditSchemaVersion: 1,
        configurationHash: "0".repeat(64),
        domainRevision: 3,
      },
    });

  it("allow one workspace per owner", async () => {
    const owner = await user();
    await getDb().workspace.create({ data: { ownerId: owner.id, name: "Personal" } });
    await expect(getDb().workspace.create({ data: { ownerId: owner.id, name: "Second" } })).rejects.toMatchObject({ code: "P2002" });
  });

  it("reject orphan relationships", async () => {
    await expect(getDb().workspace.create({ data: { ownerId: "no-such-user", name: "Orphan" } })).rejects.toMatchObject({ code: "P2003" });
    await expect(getDb().project.create({ data: { workspaceId: randomUUID(), name: "Orphan" } })).rejects.toMatchObject({ code: "P2003" });
    await expect(snapshot(randomUUID(), 1)).rejects.toMatchObject({ code: "P2003" });
  });

  it("start project version at 0, independent of the audit revision", async () => {
    const p = await project();
    expect(p.version).toBe(0);
    const s = await snapshot(p.id, 1);
    expect([s.version, s.domainRevision]).toEqual([1, 3]);
  });

  it("keep snapshot versions unique per project", async () => {
    const p = await project();
    await snapshot(p.id, 1);
    await expect(snapshot(p.id, 1)).rejects.toMatchObject({ code: "P2002" });
    await snapshot((await project()).id, 1); // same version in another project is fine
  });

  it("keep idempotency keys unique per project", async () => {
    const p = await project();
    const key = randomUUID();
    await snapshot(p.id, 1, key);
    await expect(snapshot(p.id, 2, key)).rejects.toMatchObject({ code: "P2002" });
    await snapshot((await project()).id, 1, key);
  });

  it("store the audit JSON unchanged", async () => {
    const audit = { schemaVersion: 1, nested: { quantities: ["007", "1.50"], note: "ünïcode" } };
    const p = await project();
    const s = await getDb().reconciliationSnapshot.create({
      data: { projectId: p.id, version: 1, idempotencyKey: randomUUID(), audit, auditSchemaVersion: 1, configurationHash: "h", domainRevision: 0 },
    });
    expect((await getDb().reconciliationSnapshot.findUniqueOrThrow({ where: { id: s.id } })).audit).toEqual(audit);
  });

  it("cascade snapshots when a project is deleted", async () => {
    const p = await project();
    await snapshot(p.id, 1);
    await snapshot(p.id, 2);
    await getDb().project.delete({ where: { id: p.id } });
    expect(await getDb().reconciliationSnapshot.count({ where: { projectId: p.id } })).toBe(0);
  });

  it("refuse to delete a workspace with projects, or a user with a workspace", async () => {
    const p = await project();
    const workspace = await getDb().workspace.findUniqueOrThrow({ where: { id: p.workspaceId } });
    await expect(getDb().workspace.delete({ where: { id: workspace.id } })).rejects.toMatchObject({ code: "P2003" });
    await expect(getDb().user.delete({ where: { id: workspace.ownerId } })).rejects.toMatchObject({ code: "P2003" });
  });
});
