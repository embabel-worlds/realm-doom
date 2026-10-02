import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

// The host ties a realm's saved database to the hash of db/schema.sql. A changed file locks
// players out of their history, so it stays frozen. Tables added later are made by the handlers.
test("db/schema.sql is the file installed realms already hold", () => {
  const bytes = readFileSync(new URL("../db/schema.sql", import.meta.url));
  const digest = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
  expect(digest).toBe("82264b036fe5d8eb0052f47a67a4ff316e5248794b68bf072b0c062bac089c99");
});
