import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { levels, recap, record, sessions, welcome } from "../wasm/handlers.ts";

type Rows = Record<string, string | number | null>[];

// A stand-in for the host: bun's own SQLite behind the same exec call the realm's db dependency has.
const context = () => {
  const sqlite = new Database(":memory:");
  sqlite.run(readFileSync(new URL("../db/schema.sql", import.meta.url), "utf8"));
  const exec = async (sql: string) => {
    if (/^\s*(SELECT|WITH)/i.test(sql)) return sqlite.query(sql).all() as Rows;
    sqlite.run(sql);
    return [];
  };
  return { log: () => undefined, deps: { db: { exec } } };
};

const stats = (over: Record<string, number> = {}) => ({
  episode: 1, map: 1, skill: 2, levelTime: 0,
  kills: 0, totalKills: 10, items: 0, totalItems: 8, secrets: 0, totalSecrets: 3,
  health: 100, armor: 0, weapon: 1, ammo: 50, parTime: 0,
  ...over,
});

// One session: E1M1 finished under par after one death, then E1M2 started.
const playSession = async (ctx: ReturnType<typeof context>, sessionId = "session-one", skill = 2) => {
  await record({ sessionId, event: "levelStart", stats: stats({ skill }) }, ctx);
  await record({ sessionId, event: "snapshot", stats: stats({ skill, levelTime: 350, kills: 4, health: 60 }) }, ctx);
  await record({ sessionId, event: "death", stats: stats({ skill, levelTime: 700, kills: 5, health: 0 }) }, ctx);
  await record(
    { sessionId, event: "levelComplete", stats: stats({ skill, levelTime: 1050, kills: 10, items: 4, secrets: 3, parTime: 1050 }) },
    ctx,
  );
  return record({ sessionId, event: "levelStart", stats: stats({ skill, map: 2, totalKills: 20 }) }, ctx);
};

test("welcome has a line for the app", async () => {
  expect((await welcome()).message).toContain("Wasm sandbox");
});

test("record keeps a session, its level runs and its deaths", async () => {
  const ctx = context();
  const last = await playSession(ctx);
  expect(last).toMatchObject({
    saved: "levelStart",
    levelId: "session-one-e1m2-1",
    session: { levelsPlayed: 2, levelsCompleted: 1, kills: 10, deaths: 1 },
  });
});

test("a level started again is a new attempt", async () => {
  const ctx = context();
  await record({ sessionId: "session-one", event: "levelStart", stats: stats() }, ctx);
  const again = await record({ sessionId: "session-one", event: "levelStart", stats: stats() }, ctx);
  expect(again.levelId).toBe("session-one-e1m1-2");
});

test("record refuses a bad session id, event or number", async () => {
  const ctx = context();
  await expect(record({ sessionId: "x", event: "snapshot", stats: stats() }, ctx)).rejects.toThrow("Invalid sessionId");
  await expect(record({ sessionId: "session-one", event: "cheat", stats: stats() }, ctx)).rejects.toThrow("Invalid event");
  await expect(record({ sessionId: "session-one", event: "snapshot", stats: stats({ kills: -1 }) }, ctx)).rejects.toThrow("Invalid kills");
  await expect(record({ sessionId: "session-one", event: "snapshot", stats: stats({ map: 1.5 }) }, ctx)).rejects.toThrow("Invalid map");
});

test("sessions gives every username the owner's sessions with totals", async () => {
  const ctx = context();
  await playSession(ctx);
  const result = await sessions({ username: ["james"] }, ctx);
  expect(result.next).toBeNull();
  expect(result.rows).toHaveLength(1);
  expect(result.rows[0]).toMatchObject({
    sessionId: "session-one",
    username: "james",
    skillName: "Hurt me plenty",
    lastMap: "E1M2",
    levelsPlayed: 2,
    levelsCompleted: 1,
    kills: 10,
    deaths: 1,
    hiddenAreas: 3,
    playSeconds: 30,
  });
});

test("sessions keeps only the skill levels a query pushed down", async () => {
  const ctx = context();
  await playSession(ctx, "session-one", 2);
  await playSession(ctx, "session-two", 3);
  const violent = await sessions({ username: ["james"], skillName: ["Ultra-Violence"] }, ctx);
  expect(violent.rows.map((r) => r.sessionId)).toEqual(["session-two"]);
  expect((await sessions({ username: ["james"], skillName: [] }, ctx)).rows).toEqual([]);
  expect((await sessions({ username: ["james"], skillName: ["No such skill"] }, ctx)).rows).toEqual([]);
});

test("levels reports each run against par, and keeps only the maps a query pushed down", async () => {
  const ctx = context();
  await playSession(ctx);
  const all = await levels({ sessionId: ["session-one"] }, ctx);
  expect(all.rows).toHaveLength(2);
  const first = all.rows.find((r) => r.map === "E1M1");
  expect(first).toMatchObject({
    levelId: "session-one-e1m1-1",
    completed: true,
    timeSeconds: 30,
    parSeconds: 30,
    underPar: true,
    killPercent: 100,
    itemPercent: 50,
    hiddenAreaPercent: 100,
    deaths: 1,
  });
  const second = await levels({ sessionId: ["session-one"], map: ["E1M2"] }, ctx);
  expect(second.rows.map((r) => r.map)).toEqual(["E1M2"]);
  expect(second.rows[0]).toMatchObject({ completed: false, underPar: null });
  expect((await levels({ sessionId: ["session-one"], map: [] }, ctx)).rows).toEqual([]);
});

test("the producers refuse keys, cursors and filters they can't trust", async () => {
  const ctx = context();
  await expect(sessions({ username: [] }, ctx)).rejects.toThrow("Invalid producer keys");
  await expect(levels({ sessionId: "session-one" }, ctx)).rejects.toThrow("Invalid producer keys");
  await expect(levels({ sessionId: ["session-one"], cursor: "1; DROP TABLE levels" }, ctx)).rejects.toThrow("Invalid cursor");
  await expect(levels({ sessionId: ["session-one"], map: "E1M1" }, ctx)).rejects.toThrow("Invalid filter");
});

test("a key or filter with a quote in it stays a value", async () => {
  const ctx = context();
  await playSession(ctx);
  const result = await levels({ sessionId: ["x' OR '1'='1"], map: ["E1M1' OR '1'='1"] }, ctx);
  expect(result.rows).toEqual([]);
});

test("the producers page past 200 rows with their own cursor", async () => {
  const ctx = context();
  for (let attempt = 0; attempt < 201; attempt++) {
    await record({ sessionId: "session-one", event: "levelStart", stats: stats() }, ctx);
  }
  const first = await levels({ sessionId: ["session-one"] }, ctx);
  expect(first.rows).toHaveLength(200);
  expect(first.next).toBe("200");
  const second = await levels({ sessionId: ["session-one"], cursor: first.next }, ctx);
  expect(second.rows).toHaveLength(1);
  expect(second.next).toBeNull();
});

test("recap tells the latest session level by level", async () => {
  const ctx = context();
  expect((await recap({}, ctx)).summary).toBe("Nobody has played Doom in the doom realm yet.");
  await playSession(ctx);
  const { summary } = await recap({ content: "how did my doom run go?" }, ctx);
  expect(summary).toContain('on "Hurt me plenty"');
  expect(summary).toContain("E1M1, attempt 1: finished after 0:30 (par 0:30, under par). Kills 10/10, items 4/8, hidden areas 3/3, deaths 1.");
  expect(summary).toContain("E1M2, attempt 1: not finished after 0:00.");
  expect(summary).toContain("Died on E1M1 at 0:20 with 5 kills, holding the pistol.");
});
