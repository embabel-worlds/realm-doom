import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { bests, importCard, players, recap, record, removeFriend, scoreboard, shareCard } from "../wasm/handlers.ts";

type Rows = Record<string, string | number | null>[];

// A stand-in for the host: bun's own SQLite behind the same exec call the realm's db dependency has.
const realmOn = (sqlite: Database) => {
  const exec = async (sql: string) => {
    if (/^\s*(SELECT|WITH)/i.test(sql)) return sqlite.query(sql).all() as Rows;
    sqlite.run(sql);
    return [];
  };
  return { log: () => undefined, deps: { db: { exec } }, sqlite };
};

const context = () => {
  const sqlite = new Database(":memory:");
  sqlite.run(readFileSync(new URL("../db/schema.sql", import.meta.url), "utf8"));
  return realmOn(sqlite);
};

type Ctx = ReturnType<typeof context>;

// A plain string in toThrow matches any message containing it. The refusals are asserted whole.
const exactly = (message: string) => new RegExp(`^${message.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`);

const stats = (over: Record<string, number> = {}) => ({
  episode: 1, map: 1, skill: 2, levelTime: 0,
  kills: 0, totalKills: 10, items: 0, totalItems: 8, secrets: 0, totalSecrets: 3,
  health: 100, armor: 0, weapon: 1, ammo: 50, parTime: 0,
  ...over,
});

/** Starts and finishes one level. Time is in tics, 35 to the second. */
const finish = async (ctx: Ctx, levelTime: number, over: Record<string, number> = {}, sessionId = "session-one") => {
  await record({ sessionId, event: "levelStart", stats: stats(over) }, ctx);
  await record({ sessionId, event: "levelComplete", stats: stats({ levelTime, parTime: 1050, kills: 10, items: 4, secrets: 1, ...over }) }, ctx);
};

/** A friend in a realm of their own, who has played and made a card. */
const friend = async (name: string, playerId: string, levelTime = 875) => {
  const ctx = context();
  await finish(ctx, levelTime);
  return (await shareCard({ name, playerId }, ctx)).code;
};

// The card format, rebuilt here so a test can change what is inside a card and still sign it the
// way the handler does.
const checksum = (text: string) => {
  let sum = 0;
  for (let i = 0; i < text.length; i++) sum = (sum * 31 + text.charCodeAt(i)) & 0xffff;
  return sum.toString(16).padStart(4, "0");
};

const unpack = (code: string): Record<string, unknown> => {
  const body = code.slice("DOOM1-".length, code.lastIndexOf("-"));
  return JSON.parse(Buffer.from(body, "base64url").toString("latin1"));
};

const pack = (card: Record<string, unknown>) => {
  // Everything outside ASCII is escaped, the way the handler writes a card.
  const ascii = JSON.stringify(card).replace(/[\u007f-\uffff]/g, (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"));
  const body = Buffer.from(ascii, "latin1").toString("base64url");
  return `DOOM1-${body}-${checksum(body)}`;
};

const tamper = (code: string, change: (card: Record<string, any>) => void) => {
  const card = unpack(code);
  change(card);
  return pack(card);
};

test("a card made in one realm imports into another and both players are on the scoreboard", async () => {
  const a = context();
  await finish(a, 1050);
  expect((await scoreboard({}, a)).named).toBe(false);

  const code = await friend("Bea", "beaplayer1");
  expect(code).toMatch(/^DOOM1-[A-Za-z0-9_-]+-[0-9a-f]{4}$/);
  // Whitespace a chat app adds when it wraps a long code is ignored.
  const wrapped = `${code.slice(0, 20)}\n  ${code.slice(20)} `;
  expect(await importCard({ code: wrapped }, a)).toEqual({ added: "Bea", playerId: "beaplayer1", levels: 1, replaced: false });

  const board = await scoreboard({}, a);
  expect(board.named).toBe(false);
  expect(board.players.map((p) => [p.playerId, p.name, p.isOwner])).toEqual([
    ["beaplayer1", "Bea", false],
    ["you", "You", true],
  ]);
  expect(board.players.find((p) => p.isOwner)?.cardDate).toBeNull();
  expect(typeof board.players.find((p) => !p.isOwner)?.cardDate).toBe("string");
});

test("a second card from the same player replaces the first", async () => {
  const a = context();
  const b = context();
  await finish(b, 1050);
  const first = (await shareCard({ name: "Bea", playerId: "beaplayer1" }, b)).code;
  await finish(b, 875, { map: 2 }, "session-two");
  const second = (await shareCard({ name: "Bea", playerId: "beaplayer1" }, b)).code;

  expect((await importCard({ code: first }, a)).replaced).toBe(false);
  expect(await importCard({ code: second }, a)).toMatchObject({ playerId: "beaplayer1", levels: 2, replaced: true });
  expect(a.sqlite.query("SELECT COUNT(*) AS n FROM friends").get()).toEqual({ n: 1 });
  expect((await scoreboard({}, a)).players).toHaveLength(2);
});

test("the first player id sticks when a later card names another", async () => {
  const b = context();
  expect(await shareCard({ name: "Bea", playerId: "beaplayer1" }, b)).toMatchObject({ name: "Bea", playerId: "beaplayer1" });
  expect(await shareCard({ name: "Beatrice", playerId: "otherid22" }, b)).toMatchObject({ name: "Beatrice", playerId: "beaplayer1" });
  const board = await scoreboard({}, b);
  expect(board.named).toBe(true);
  expect(board.players[0]).toMatchObject({ playerId: "beaplayer1", name: "Beatrice", isOwner: true });
});

// The host drops a thrown error's message, so a refusal the player should read comes back as a
// result. These resolve, and the result is the refusal and nothing else.
const refused = (message: string) => ({ refused: message });

test("every refusal comes back as a result with its own message", async () => {
  const a = context();
  const code = await friend("Bea", "beaplayer1");

  await expect(importCard({ code: code.slice(0, code.length - 12) }, a)).resolves.toEqual(refused("That card is incomplete. Copy the whole code and try again"));
  await expect(importCard({ code: code.replace("DOOM1-", "DOOM2-") }, a)).resolves.toEqual(refused("That isn't a Doom card"));
  await expect(importCard({ code: 42 }, a)).resolves.toEqual(refused("That isn't a Doom card"));
  await expect(importCard({}, a)).resolves.toEqual(refused("That isn't a Doom card"));
  // Characters outside the card alphabet, signed so they get past the checksum.
  const garbled = `DOOM1-${"!!!!"}-${checksum("!!!!")}`;
  await expect(importCard({ code: garbled }, a)).resolves.toEqual(refused("That isn't a Doom card"));
  await expect(importCard({ code: tamper(code, (card) => { card.v = 2; }) }, a)).resolves.toEqual(refused("That card is from a version this realm can't read"));

  const mine = (await shareCard({ name: "Al", playerId: "alplayer1" }, a)).code;
  await expect(importCard({ code: mine }, a)).resolves.toEqual(refused("That's your own card"));

  await expect(shareCard({ name: "   ", playerId: "alplayer1" }, a)).resolves.toEqual(refused("Invalid name"));
  await expect(shareCard({ name: "x".repeat(25), playerId: "alplayer1" }, a)).resolves.toEqual(refused("Invalid name"));
  await expect(shareCard({ name: 7, playerId: "alplayer1" }, a)).resolves.toEqual(refused("Invalid name"));
  await expect(shareCard({ name: "Al", playerId: "Al" }, a)).resolves.toEqual(refused("Invalid playerId"));
  await expect(removeFriend({ playerId: "no" }, a)).resolves.toEqual(refused("Invalid playerId"));
  await expect(removeFriend({}, a)).resolves.toEqual(refused("Invalid playerId"));
  expect(a.sqlite.query("SELECT COUNT(*) AS n FROM friends").get()).toEqual({ n: 0 });
});

test("a result that succeeded has no refused key", async () => {
  const a = context();
  const shared = await shareCard({ name: "Al", playerId: "alplayer1" }, a);
  const imported = await importCard({ code: await friend("Bea", "beaplayer1") }, a);
  const removed = await removeFriend({ playerId: "beaplayer1" }, a);
  for (const result of [shared, imported, removed]) expect(result).not.toHaveProperty("refused");
});

test("a database that fails makes importCard reject", async () => {
  const code = await friend("Bea", "beaplayer1");
  const broken = { log: () => undefined, deps: { db: { exec: async (_sql: string): Promise<Rows> => { throw new Error("boom"); } } } };
  await expect(importCard({ code }, broken)).rejects.toThrow(exactly("boom"));

  // The same, failing only once the card has been checked and is being saved.
  const a = context();
  const savingFails = {
    log: () => undefined,
    deps: { db: { exec: async (sql: string) => { if (/^INSERT INTO friends/.test(sql)) throw new Error("boom"); return a.deps.db.exec(sql); } } },
  };
  await expect(importCard({ code }, savingFails)).rejects.toThrow(exactly("boom"));
});

test("players takes the cursor the host resends and refuses one this realm never wrote", async () => {
  const a = context();
  expect((await players({ username: ["james"], cursor: "0" }, a)).next).toBeNull();
  await expect(players({ username: ["james"], cursor: "x" }, a)).rejects.toThrow(exactly("Invalid cursor"));
});

test("a 33rd friend is refused until one is removed, and a held friend can still update", async () => {
  const a = context();
  const codes: string[] = [];
  for (let i = 0; i < 33; i++) codes.push(await friend(`Friend ${i}`, `friend${String(i).padStart(4, "0")}`));
  for (const code of codes.slice(0, 32)) await importCard({ code }, a);

  await expect(importCard({ code: codes[32] }, a)).resolves.toEqual(refused("The scoreboard holds 32 friends. Remove one first"));
  expect((await importCard({ code: codes[0] }, a)).replaced).toBe(true);
  await removeFriend({ playerId: "friend0000" }, a);
  expect((await importCard({ code: codes[32] }, a)).added).toBe("Friend 32");
});

test("a card with a malformed field inside is refused as not a Doom card", async () => {
  const a = context();
  const code = await friend("Bea", "beaplayer1");

  const tooMany = tamper(code, (card) => { card.bests = Array.from({ length: 65 }, () => card.bests[0]); });
  const negative = tamper(code, (card) => { card.bests[0][4] = -1; });
  const badMap = tamper(code, (card) => { card.bests[0][0] = "E1M10"; });
  const longName = tamper(code, (card) => { card.name = "x".repeat(25); });
  const badSkill = tamper(code, (card) => { card.bests[0][1] = 9; });
  for (const bad of [tooMany, negative, badMap, longName, badSkill]) {
    await expect(importCard({ code: bad }, a)).resolves.toEqual(refused("That isn't a Doom card"));
  }
});

test("a card with exactly 64 bests is accepted", async () => {
  const a = context();
  const code = await friend("Bea", "beaplayer1");
  const atLimit = tamper(code, (card) => {
    card.bests = Array.from({ length: 64 }, (_, i) => [`E${1 + Math.floor(i / 9)}M${1 + (i % 9)}`, ...card.bests[0].slice(1)]);
  });
  expect((await importCard({ code: atLimit }, a)).levels).toBe(64);
});

test("a hostile player name is stored as written and the tables still answer", async () => {
  const a = context();
  const hostile = "Rob'); DROP TABLE x;--";
  expect(hostile).toHaveLength(22);
  a.sqlite.run("CREATE TABLE x (y INTEGER)");

  const code = await friend(hostile, "robplayer1");
  expect(await importCard({ code }, a)).toMatchObject({ added: hostile, playerId: "robplayer1" });
  expect(a.sqlite.query("SELECT name FROM friends").all()).toEqual([{ name: hostile }]);
  expect(a.sqlite.query("SELECT COUNT(*) AS n FROM x").get()).toEqual({ n: 0 });
  expect((await scoreboard({}, a)).players.map((p) => p.name)).toContain(hostile);
  expect((await bests({ playerId: ["robplayer1"] }, a)).rows[0].playerName).toBe(hostile);
});

test("the fastest run ranks first and wins the level, and equal times share a rank", async () => {
  const a = context();
  await finish(a, 1050);
  await importCard({ code: await friend("Bea", "beaplayer1", 875) }, a);

  const board = await scoreboard({}, a);
  expect(board.levels).toHaveLength(1);
  expect(board.levels[0]).toMatchObject({ map: "E1M1", skill: 2, skillName: "Hurt me plenty", par: "0:30" });
  expect(board.levels[0].standings.map((s) => [s.playerId, s.rank, s.time])).toEqual([
    ["beaplayer1", 1, "0:25"],
    ["you", 2, "0:30"],
  ]);
  expect(board.players.map((p) => [p.playerId, p.wins])).toEqual([
    ["beaplayer1", 1],
    ["you", 0],
  ]);

  const tied = context();
  await finish(tied, 1050);
  await importCard({ code: await friend("Bea", "beaplayer1", 1050) }, tied);
  const even = await scoreboard({}, tied);
  expect(even.levels[0].standings.map((s) => s.rank)).toEqual([1, 1]);
});

test("a level nobody else finished earns no win, and an unfinished best has no rank", async () => {
  const a = context();
  await finish(a, 1050);
  await record({ sessionId: "session-one", event: "levelStart", stats: stats({ map: 2 }) }, a);
  const b = context();
  await record({ sessionId: "session-one", event: "levelStart", stats: stats() }, b);
  await importCard({ code: (await shareCard({ name: "Bea", playerId: "beaplayer1" }, b)).code }, a);

  const board = await scoreboard({}, a);
  const e1m1 = board.levels.find((l) => l.map === "E1M1");
  expect(e1m1?.standings.map((s) => [s.playerId, s.rank, s.finished])).toEqual([
    ["you", 1, true],
    ["beaplayer1", null, false],
  ]);
  expect(board.levels.find((l) => l.map === "E1M2")?.standings[0].rank).toBeNull();
  expect(board.players.every((p) => p.wins === 0)).toBe(true);
});

test("a run under par with every kill, item and hidden area earns all three awards", async () => {
  const a = context();
  await finish(a, 1000, { kills: 10, items: 8, secrets: 3 });
  await finish(a, 1100, { map: 2, kills: 9 }, "session-two");
  const board = await scoreboard({}, a);
  expect(board.levels.find((l) => l.map === "E1M1")?.standings[0].awards).toEqual(["Impressive", "Excellent", "Perfect"]);
  expect(board.levels.find((l) => l.map === "E1M2")?.standings[0].awards).toEqual([]);
  expect(board.players[0]).toMatchObject({ levelsFinished: 2, levelsUnderPar: 1 });
});

test("removing a friend works once and takes their bests with them", async () => {
  const a = context();
  await importCard({ code: await friend("Bea", "beaplayer1") }, a);
  expect((await bests({ playerId: ["beaplayer1"] }, a)).rows).toHaveLength(1);

  expect(await removeFriend({ playerId: "beaplayer1" }, a)).toEqual({ removed: true });
  expect(await removeFriend({ playerId: "beaplayer1" }, a)).toEqual({ removed: false });
  expect((await bests({ playerId: ["beaplayer1"] }, a)).rows).toEqual([]);
  expect(a.sqlite.query("SELECT COUNT(*) AS n FROM friend_bests").get()).toEqual({ n: 0 });
  expect((await scoreboard({}, a)).players.map((p) => p.playerId)).toEqual(["you"]);
});

test("players gives one row per player per username, the owner first and then friends by name", async () => {
  const a = context();
  await importCard({ code: await friend("Zed", "zedplayer1", 875) }, a);
  await importCard({ code: await friend("Amy", "amyplayer1", 1050) }, a);

  const result = await players({ username: ["james", "ann"] }, a);
  expect(result.next).toBeNull();
  expect(result.rows.map((r) => [r.name, r.username])).toEqual([
    ["You", "james"],
    ["You", "ann"],
    ["Amy", "james"],
    ["Amy", "ann"],
    ["Zed", "james"],
    ["Zed", "ann"],
  ]);
  expect(result.rows[0]).toMatchObject({ playerId: "you", isOwner: true, cardDate: null });
  expect(result.rows.find((r) => r.name === "Zed")).toMatchObject({ wins: 1, levelsFinished: 1, levelsUnderPar: 1 });
  // The scoreboard puts the leader first.
  expect((await scoreboard({}, a)).players[0].name).toBe("Zed");
  await expect(players({ username: [] }, a)).rejects.toThrow(exactly("Invalid producer keys"));
});

test("bests returns only the players and maps asked for, each with its own id", async () => {
  const a = context();
  await finish(a, 1050);
  await finish(a, 1050, { map: 2 }, "session-two");
  await importCard({ code: await friend("Bea", "beaplayer1") }, a);
  await importCard({ code: await friend("Cy", "cyplayer01") }, a);

  const two = await bests({ playerId: ["you", "beaplayer1"] }, a);
  expect(two.next).toBeNull();
  expect(new Set(two.rows.map((r) => r.playerId))).toEqual(new Set(["you", "beaplayer1"]));
  expect(two.rows).toHaveLength(3);
  expect(new Set(two.rows.map((r) => r.bestId)).size).toBe(two.rows.length);
  expect(two.rows.find((r) => r.playerId === "beaplayer1")).toMatchObject({
    playerName: "Bea", map: "E1M1", skill: 2, skillName: "Hurt me plenty", rank: 1, bestSeconds: 25, parSeconds: 30, underPar: true,
  });

  const e1m1 = await bests({ playerId: ["you", "beaplayer1", "cyplayer01"], map: ["E1M1"] }, a);
  expect(e1m1.rows.map((r) => r.map)).toEqual(["E1M1", "E1M1", "E1M1"]);
  expect(new Set(e1m1.rows.map((r) => r.bestId)).size).toBe(3);
  expect((await bests({ playerId: ["you"], map: [] }, a)).rows).toEqual([]);
});

test("a database without the friend tables still answers the scoreboard", async () => {
  const sqlite = new Database(":memory:");
  const schema = readFileSync(new URL("../db/schema.sql", import.meta.url), "utf8");
  // Only the sessions, levels, deaths and snapshots tables, cut out of the schema.
  for (const table of ["sessions", "levels", "deaths", "snapshots"]) {
    const statement = schema.match(new RegExp(`CREATE TABLE ${table} \\([^;]*\\);`))?.[0];
    expect(statement).toBeDefined();
    sqlite.run(statement as string);
  }
  const old = realmOn(sqlite);
  await finish(old, 1050);

  const board = await scoreboard({}, old);
  expect(board.named).toBe(false);
  expect(board.players.map((p) => p.playerId)).toEqual(["you"]);
  expect(board.levels[0].standings[0]).toMatchObject({ rank: 1, time: "0:30" });
  await importCard({ code: await friend("Bea", "beaplayer1") }, old);
  expect((await scoreboard({}, old)).players).toHaveLength(2);
});

/** Starts a level and dies on it, so the run is never finished. */
const die = async (ctx: Ctx, levelTime: number, over: Record<string, number> = {}, sessionId = "session-one") => {
  await record({ sessionId, event: "levelStart", stats: stats(over) }, ctx);
  await record({ sessionId, event: "death", stats: stats({ levelTime, ...over }) }, ctx);
};

test("a best's counts and medals come from the run that set the time", async () => {
  const a = context();
  // Finished in 14 seconds with 2 of 10 kills, 4 of 8 items and 1 of 3 hidden areas.
  await finish(a, 490, { kills: 2 });
  // A later run that cleared the level and died before the exit.
  await die(a, 2000, { kills: 10, items: 8, secrets: 3 }, "session-two");

  const own = (await scoreboard({}, a)).levels[0].standings[0];
  expect(own).toMatchObject({ bestSeconds: 14, killPercent: 20, itemPercent: 50, hiddenAreaPercent: 33, deaths: 1, runs: 1, awards: ["Impressive"] });
  const card = unpack((await shareCard({ name: "Al", playerId: "alplayer1" }, a)).code);
  expect(card.bests).toEqual([["E1M1", 2, 490, 1050, 2, 10, 4, 8, 1, 3, 1, 1]]);
});

test("when two finished runs tie on time, the more recent one's counts count", async () => {
  const a = context();
  await finish(a, 1050, { kills: 10, items: 8, secrets: 3 });
  await finish(a, 1050, { kills: 5 }, "session-two");
  const own = (await scoreboard({}, a)).levels[0].standings[0];
  expect(own).toMatchObject({ bestSeconds: 30, killPercent: 50, itemPercent: 50, runs: 2, awards: ["Impressive"] });
});

test("a level never finished takes the counts of its most recent run", async () => {
  const a = context();
  await die(a, 700, { kills: 9, items: 8 });
  await die(a, 300, { kills: 3, items: 1 }, "session-two");
  const own = (await scoreboard({}, a)).levels[0].standings[0];
  expect(own).toMatchObject({ finished: false, bestSeconds: null, killPercent: 30, itemPercent: 13, deaths: 2, runs: 0, awards: [] });
});

test("a name that could hide or reorder text is refused", async () => {
  const a = context();
  const hiding = ["Al\u0085", "A​l", "A‏l", "‮Al", "A‪l", "A⁦l", "A⁩l", "﻿Al", "Al\ud800", "\udc00Al", "A\udfff\ud83dl"];
  for (const name of hiding) {
    await expect(shareCard({ name, playerId: "alplayer1" }, a)).resolves.toEqual(refused("Invalid name"));
  }
  // A paired surrogate is an ordinary character.
  expect(await shareCard({ name: "Al 😀", playerId: "alplayer1" }, a)).toMatchObject({ name: "Al 😀" });

  const b = context();
  const code = await friend("Bea", "beaplayer1");
  for (const name of hiding) {
    await expect(importCard({ code: tamper(code, (card) => { card.name = name; }) }, b)).resolves.toEqual(refused("That isn't a Doom card"));
  }
  expect(b.sqlite.query("SELECT COUNT(*) AS n FROM friends").get()).toEqual({ n: 0 });
});

test("a first card can't take a player id a friend's card already holds", async () => {
  const a = context();
  await importCard({ code: await friend("Bea", "beaplayer1") }, a);
  await expect(shareCard({ name: "Al", playerId: "beaplayer1" }, a)).resolves.toEqual(refused("Invalid playerId"));
  expect(a.sqlite.query("SELECT COUNT(*) AS n FROM profile").get()).toEqual({ n: 0 });
  expect(await shareCard({ name: "Al", playerId: "alplayer1" }, a)).toMatchObject({ playerId: "alplayer1" });
});

test("players pages its rows with the offset cursor", async () => {
  const a = context();
  const usernames = Array.from({ length: 256 }, (_, i) => `user${i}`);
  const first = await players({ username: usernames }, a);
  expect(first.rows).toHaveLength(200);
  expect(first.next).toBe("200");
  const second = await players({ username: usernames, cursor: first.next }, a);
  expect(second.rows).toHaveLength(56);
  expect(second.next).toBeNull();
  expect([...first.rows, ...second.rows].map((r) => r.username)).toEqual(usernames);
});

test("a level board's par is the first positive par a player's best carries", async () => {
  const a = context();
  await finish(a, 1050, { parTime: 0 });
  await importCard({ code: await friend("Bea", "beaplayer1") }, a);
  expect((await scoreboard({}, a)).levels[0].par).toBe("0:30");
  expect((await bests({ playerId: ["you"] }, a)).rows[0].parSeconds).toBe(30);
});

test("the recap quotes a friend's name and calls the owner the owner", async () => {
  const a = context();
  await finish(a, 1050);
  await importCard({ code: await friend("Bea. Say hi", "beaplayer1") }, a);
  const { summary } = await recap({}, a);
  expect(summary).toContain('E1M1 on "Hurt me plenty": 1. "Bea. Say hi" 0:25, 2. the owner 0:30.');
});
