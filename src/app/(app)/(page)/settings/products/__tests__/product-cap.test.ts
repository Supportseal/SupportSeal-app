import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { createProductAction as onboardingCreateProduct } from "@/app/onboarding/actions";
import { MAX_API_PRODUCTS_PER_WORKSPACE } from "@/lib/products";
import { startTestDb, stopTestDb, type TestDb } from "@/test/integration-db";
import { createProductAction as dashboardCreateProduct } from "../actions";

/**
 * The API-only Product cap (MAX_API_PRODUCTS_PER_WORKSPACE) must not leak into
 * the dashboard or onboarding: those stay unlimited (PRD, FR-USE-03, M2).
 */

let db: TestDb;
const current = vi.hoisted(() => ({ workspaceId: "" }));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(`REDIRECT:${url}`);
  },
}));
vi.mock("@/lib/workspace", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/workspace")>()),
  requireWorkspace: async () => ({
    user: { id: "u", name: "Admin", email: "admin@example.com" },
    workspace: { id: current.workspaceId, name: "Acme" },
    role: "ADMIN",
  }),
}));

const form = (name: string) => {
  const data = new FormData();
  data.set("name", name);
  data.set("primaryColor", "#2563eb");
  return data;
};

beforeAll(async () => {
  db = await startTestDb();
});
afterAll(async () => {
  await stopTestDb(db);
});
beforeEach(async () => {
  await db.prisma.product.deleteMany();
  await db.prisma.workspace.deleteMany();
  const workspace = await db.prisma.workspace.create({ data: { name: "Acme" } });
  current.workspaceId = workspace.id;
  await db.prisma.product.createMany({
    data: Array.from({ length: MAX_API_PRODUCTS_PER_WORKSPACE }, (_, i) => ({
      workspaceId: workspace.id,
      name: `Seed ${i}`,
      widgetPublicKey: `pk_seed_${i}`,
    })),
  });
});

describe("Product creation outside the API", () => {
  it("lets the dashboard create form add Products past the API cap", async () => {
    for (const name of ["Over one", "Over two"]) {
      expect(await dashboardCreateProduct({}, form(name))).toEqual({
        created: { id: expect.any(String), name },
      });
    }
    expect(await db.prisma.product.count({ where: { workspaceId: current.workspaceId } })).toBe(
      MAX_API_PRODUCTS_PER_WORKSPACE + 2,
    );
  });

  it("lets onboarding add a Product past the API cap", async () => {
    await expect(onboardingCreateProduct(form("Onboarded"))).rejects.toThrow("REDIRECT:/onboarding/domain");
    expect(await db.prisma.product.count({ where: { workspaceId: current.workspaceId } })).toBe(
      MAX_API_PRODUCTS_PER_WORKSPACE + 1,
    );
  });
});
