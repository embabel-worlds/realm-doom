/** One row back from SQLite. */
type Row = Record<string, string | number | null>;

/** The realm's own SQLite, mounted by the host from the `db` dependency. */
interface Db {
  exec(sql: string): Promise<Row[]>;
}

interface Ctx {
  log(line: string): void;
  deps: { db: Db };
}

/**
 * The key sessions are filed under. This installation belongs to one owner, so the producers
 * return every row for whichever username the host asks about, and nothing depends on the
 * owner's actual username.
 */
const OWNER = "owner";

/** Doom counts time in tics, 35 to the second. */
const TICRATE = 35;

const SKILLS = ["I'm too young to die", "Hey, not too rough", "Hurt me plenty", "Ultra-Violence", "Nightmare!"];
const WEAPONS = ["fist", "pistol", "shotgun", "chaingun", "rocket launcher", "plasma rifle", "BFG 9000", "chainsaw", "super shotgun"];
const EVENTS = new Set(["snapshot", "levelStart", "levelComplete", "death"]);

/** The line the app shows above the game. */
export const welcome = async () => ({
  message: "Knee-deep in the dead, inside a Wasm sandbox. Click the screen, then Enter to start. Your stats go to the realm's own SQLite.",
});

/**
 * A single-quoted SQLite string literal. The host's `exec` takes no bound parameters, so every
 * value goes in as a literal with its quotes doubled. Everything passed here is checked first.
 */
const sql = (value: string): string => `'${value.replaceAll("'", "''")}'`;

/** A number from SQLite, which may hand one back as text. */
const num = (value: unknown): number => {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
};

/** A whole number inside the given range, or a refusal. */
const int = (value: unknown, min: number, max: number, name: string): number => {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    throw new Error(`Invalid ${name}`);
  }
  return value;
};

const SESSION_ID = /^[a-z0-9][a-z0-9-]{3,63}$/;

/** The game numbers the app reads out of the engine, each one range checked. */
interface Stats {
  episode: number;
  map: number;
  skill: number;
  levelTime: number;
  kills: number;
  totalKills: number;
  items: number;
  totalItems: number;
  secrets: number;
  totalSecrets: number;
  health: number;
  armor: number;
  weapon: number;
  ammo: number;
  parTime: number;
}

const statsIn = (value: unknown): Stats => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Invalid stats");
  const raw = value as Record<string, unknown>;
  const big = 100_000_000;
  return {
    episode: int(raw.episode, 1, 9, "episode"),
    map: int(raw.map, 1, 99, "map"),
    skill: int(raw.skill, 0, 4, "skill"),
    levelTime: int(raw.levelTime, 0, big, "levelTime"),
    kills: int(raw.kills, 0, 100_000, "kills"),
    totalKills: int(raw.totalKills, 0, 100_000, "totalKills"),
    items: int(raw.items, 0, 100_000, "items"),
    totalItems: int(raw.totalItems, 0, 100_000, "totalItems"),
    secrets: int(raw.secrets, 0, 100_000, "secrets"),
    totalSecrets: int(raw.totalSecrets, 0, 100_000, "totalSecrets"),
    health: int(raw.health, -1000, 1000, "health"),
    armor: int(raw.armor, 0, 1000, "armor"),
    weapon: int(raw.weapon, 0, WEAPONS.length - 1, "weapon"),
    ammo: int(raw.ammo, -1, 10_000, "ammo"),
    parTime: int(raw.parTime ?? 0, 0, big, "parTime"),
  };
};

/** E1M1 and friends. */
const mapName = (s: Stats) => `E${s.episode}M${s.map}`;

/** Makes sure the session row exists and carries the latest player state. */
const touchSession = async (db: Db, sessionId: string, s: Stats, now: string) => {
  await db.exec(
    `INSERT INTO sessions (session_id, username, started_at, updated_at, skill, last_map, health, armor, weapon, ammo) VALUES (${sql(sessionId)}, ${sql(OWNER)}, ${sql(now)}, ${sql(now)}, ${s.skill}, ${sql(mapName(s))}, ${s.health}, ${s.armor}, ${sql(WEAPONS[s.weapon])}, ${s.ammo}) ` +
      "ON CONFLICT(session_id) DO UPDATE SET updated_at = excluded.updated_at, skill = excluded.skill, last_map = excluded.last_map, health = excluded.health, armor = excluded.armor, weapon = excluded.weapon, ammo = excluded.ammo",
  );
};

/** The level run the player is on right now: the newest unfinished one for this map, made if missing. */
const currentLevel = async (db: Db, sessionId: string, s: Stats, now: string, fresh: boolean): Promise<string> => {
  const map = mapName(s);
  if (!fresh) {
    const open = await db.exec(
      `SELECT level_id FROM levels WHERE session_id = ${sql(sessionId)} AND map = ${sql(map)} AND completed_at IS NULL ORDER BY attempt DESC LIMIT 1`,
    );
    if (open[0]) return String(open[0].level_id);
  }
  const count = await db.exec(`SELECT COUNT(*) AS n FROM levels WHERE session_id = ${sql(sessionId)} AND map = ${sql(map)}`);
  const attempt = num(count[0]?.n) + 1;
  const levelId = `${sessionId}-${map.toLowerCase()}-${attempt}`;
  await db.exec(
    `INSERT INTO levels (level_id, session_id, map, episode, map_number, attempt, skill, started_at, updated_at, total_kills, total_items, total_secrets) VALUES (${sql(levelId)}, ${sql(sessionId)}, ${sql(map)}, ${s.episode}, ${s.map}, ${attempt}, ${s.skill}, ${sql(now)}, ${sql(now)}, ${s.totalKills}, ${s.totalItems}, ${s.totalSecrets})`,
  );
  return levelId;
};

/** Copies the live counts onto a level run. */
const updateLevel = async (db: Db, levelId: string, s: Stats, now: string, extra = "") => {
  await db.exec(
    `UPDATE levels SET updated_at = ${sql(now)}, time_tics = ${s.levelTime}, kills = ${s.kills}, total_kills = ${s.totalKills}, items = ${s.items}, total_items = ${s.totalItems}, secrets = ${s.secrets}, total_secrets = ${s.totalSecrets}${extra} WHERE level_id = ${sql(levelId)}`,
  );
};

/** What the app shows in its strip after each save: totals for this session so far. */
const sessionSummary = async (db: Db, sessionId: string) => {
  const row = (
    await db.exec(
      `SELECT COUNT(*) AS levels, SUM(CASE WHEN completed_at IS NOT NULL THEN 1 ELSE 0 END) AS completed, SUM(kills) AS kills, SUM(deaths) AS deaths FROM levels WHERE session_id = ${sql(sessionId)}`,
    )
  )[0];
  return {
    sessionId,
    levelsPlayed: num(row?.levels),
    levelsCompleted: num(row?.completed),
    kills: num(row?.kills),
    deaths: num(row?.deaths),
  };
};

/** Keeps the snapshot table from growing without end: the newest few thousand stay. */
const MAX_SNAPSHOTS = 5000;

/**
 * Saves one thing that happened in the game: a periodic snapshot, a level starting, a level
 * finished, or the player dying. The app sends these while you play.
 */
export const record = async (input: { sessionId?: unknown; event?: unknown; stats?: unknown }, ctx: Ctx) => {
  const db = ctx.deps.db;
  const sessionId = input?.sessionId;
  const event = input?.event;
  if (typeof sessionId !== "string" || !SESSION_ID.test(sessionId)) throw new Error("Invalid sessionId");
  if (typeof event !== "string" || !EVENTS.has(event)) throw new Error("Invalid event");
  const s = statsIn(input.stats);
  const now = new Date().toISOString();
  const map = mapName(s);

  await touchSession(db, sessionId, s, now);
  const levelId = await currentLevel(db, sessionId, s, now, event === "levelStart");

  if (event === "levelComplete") {
    await updateLevel(db, levelId, s, now, `, completed_at = ${sql(now)}, par_tics = ${s.parTime}`);
  } else if (event === "death") {
    await updateLevel(db, levelId, s, now, ", deaths = deaths + 1");
    await db.exec(
      `INSERT INTO deaths (session_id, level_id, map, died_at, time_tics, kills, weapon) VALUES (${sql(sessionId)}, ${sql(levelId)}, ${sql(map)}, ${sql(now)}, ${s.levelTime}, ${s.kills}, ${sql(WEAPONS[s.weapon])})`,
    );
  } else {
    await updateLevel(db, levelId, s, now);
  }

  if (event === "snapshot") {
    await db.exec(
      `INSERT INTO snapshots (session_id, map, taken_at, time_tics, health, armor, weapon, ammo, kills, items, secrets) VALUES (${sql(sessionId)}, ${sql(map)}, ${sql(now)}, ${s.levelTime}, ${s.health}, ${s.armor}, ${sql(WEAPONS[s.weapon])}, ${s.ammo}, ${s.kills}, ${s.items}, ${s.secrets})`,
    );
    await db.exec(
      `DELETE FROM snapshots WHERE snapshot_id <= (SELECT MAX(snapshot_id) FROM snapshots) - ${MAX_SNAPSHOTS}`,
    );
  }

  ctx.log(`doom.record: ${event} on ${map}`);
  return { saved: event, levelId, session: await sessionSummary(db, sessionId) };
};

/** The host refuses a producer result past this many rows, and pages through the rest. */
const PAGE_SIZE = 200;
const MAX_KEYS = 256;

/** The keys a producer hands over, checked before anything is read for them. */
const producerKeys = (value: unknown): string[] => {
  if (
    !Array.isArray(value) ||
    value.length < 1 ||
    value.length > MAX_KEYS ||
    value.some((key) => typeof key !== "string" || key.length < 1 || key.length > 256)
  ) {
    throw new Error("Invalid producer keys");
  }
  return value as string[];
};

/** A row offset this realm wrote as its cursor, or zero on the first page. */
const offsetCursor = (value: unknown): number => {
  if (value === undefined || value === null) return 0;
  if (typeof value !== "string" || !/^[0-9]{1,7}$/.test(value)) throw new Error("Invalid cursor");
  return Number.parseInt(value, 10);
};

/**
 * A filter the query pushed down, as the values SQLite should keep. Undefined means the query set
 * none. An empty list means the query's filters allow nothing, so nothing is read.
 */
const pushed = (value: unknown): string[] | undefined => {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.length > 64 || value.some((v) => typeof v !== "string")) {
    throw new Error("Invalid filter");
  }
  return value as string[];
};

const percent = (part: number, whole: number) => (whole > 0 ? Math.round((part * 100) / whole) : 100);
const seconds = (tics: number) => Math.round(tics / TICRATE);

// Doom's secrets go out as hidden areas: the graph's governance drops any field named like a secret.

/**
 * The producer behind (:AssistantUser)-[:PLAYED_DOOM]->(:DoomSession). Every session is the
 * owner's, so each username the host asks for gets all of them.
 */
export const sessions = async (input: { username?: unknown; cursor?: unknown; skillName?: unknown }, ctx: Ctx) => {
  const usernames = producerKeys(input?.username);
  const offset = offsetCursor(input?.cursor);
  const skillNames = pushed(input?.skillName);
  // Skill is stored as Doom's own number, so a pushed name becomes the numbers it stands for.
  const skills = skillNames?.map((name) => SKILLS.indexOf(name)).filter((skill) => skill >= 0);
  const where = skills === undefined ? "" : skills.length === 0 ? "WHERE 0 " : `WHERE s.skill IN (${skills.join(", ")}) `;
  const rows = await ctx.deps.db.exec(
    "SELECT s.session_id, s.username, s.started_at, s.updated_at, s.skill, s.last_map, s.health, s.armor, s.weapon, s.ammo, " +
      "COUNT(l.level_id) AS levels_played, COALESCE(SUM(CASE WHEN l.completed_at IS NOT NULL THEN 1 ELSE 0 END), 0) AS levels_completed, " +
      "COALESCE(SUM(l.kills), 0) AS kills, COALESCE(SUM(l.total_kills), 0) AS total_kills, COALESCE(SUM(l.items), 0) AS items, COALESCE(SUM(l.total_items), 0) AS total_items, " +
      "COALESCE(SUM(l.secrets), 0) AS secrets, COALESCE(SUM(l.total_secrets), 0) AS total_secrets, COALESCE(SUM(l.deaths), 0) AS deaths, COALESCE(SUM(l.time_tics), 0) AS time_tics " +
      `FROM sessions s LEFT JOIN levels l ON l.session_id = s.session_id ${where}` +
      `GROUP BY s.session_id ORDER BY s.started_at DESC LIMIT ${PAGE_SIZE + 1} OFFSET ${offset}`,
  );
  const page = rows.slice(0, PAGE_SIZE).flatMap((r) => usernames.map((username) => ({
    sessionId: String(r.session_id),
    username,
    startedAt: String(r.started_at),
    lastPlayedAt: String(r.updated_at),
    skill: num(r.skill),
    skillName: SKILLS[num(r.skill)] ?? "unknown",
    lastMap: r.last_map === null ? null : String(r.last_map),
    health: num(r.health),
    armor: num(r.armor),
    weapon: r.weapon === null ? null : String(r.weapon),
    ammo: num(r.ammo),
    levelsPlayed: num(r.levels_played),
    levelsCompleted: num(r.levels_completed),
    kills: num(r.kills),
    totalKills: num(r.total_kills),
    killPercent: percent(num(r.kills), num(r.total_kills)),
    items: num(r.items),
    itemPercent: percent(num(r.items), num(r.total_items)),
    hiddenAreas: num(r.secrets),
    hiddenAreaPercent: percent(num(r.secrets), num(r.total_secrets)),
    deaths: num(r.deaths),
    playSeconds: seconds(num(r.time_tics)),
  })));
  ctx.log(`doom.sessions: ${page.length} sessions`);
  return { rows: page, next: rows.length > PAGE_SIZE ? String(offset + PAGE_SIZE) : null };
};

/**
 * The producer behind (:DoomSession)-[:HAS_LEVEL]->(:DoomLevel). One row per level run, each
 * carrying the sessionId it belongs to.
 */
export const levels = async (input: { sessionId?: unknown; cursor?: unknown; map?: unknown }, ctx: Ctx) => {
  const sessionIds = producerKeys(input?.sessionId);
  const offset = offsetCursor(input?.cursor);
  const maps = pushed(input?.map);
  const onMaps = maps === undefined ? "" : maps.length === 0 ? " AND 0" : ` AND l.map IN (${maps.map(sql).join(", ")})`;
  const rows = await ctx.deps.db.exec(
    "SELECT l.*, s.username FROM levels l JOIN sessions s ON s.session_id = l.session_id " +
      `WHERE l.session_id IN (${sessionIds.map(sql).join(", ")})${onMaps} ORDER BY l.started_at DESC LIMIT ${PAGE_SIZE + 1} OFFSET ${offset}`,
  );
  const page = rows.slice(0, PAGE_SIZE).map((r) => {
    const time = num(r.time_tics);
    const par = r.par_tics === null ? null : num(r.par_tics);
    return {
      levelId: String(r.level_id),
      sessionId: String(r.session_id),
      username: String(r.username),
      map: String(r.map),
      episode: num(r.episode),
      mapNumber: num(r.map_number),
      attempt: num(r.attempt),
      skill: num(r.skill),
      skillName: SKILLS[num(r.skill)] ?? "unknown",
      startedAt: String(r.started_at),
      completed: r.completed_at !== null,
      completedAt: r.completed_at === null ? null : String(r.completed_at),
      timeSeconds: seconds(time),
      parSeconds: par === null ? null : seconds(par),
      underPar: par === null || par === 0 ? null : time <= par,
      kills: num(r.kills),
      totalKills: num(r.total_kills),
      killPercent: percent(num(r.kills), num(r.total_kills)),
      items: num(r.items),
      totalItems: num(r.total_items),
      itemPercent: percent(num(r.items), num(r.total_items)),
      hiddenAreas: num(r.secrets),
      totalHiddenAreas: num(r.total_secrets),
      hiddenAreaPercent: percent(num(r.secrets), num(r.total_secrets)),
      deaths: num(r.deaths),
    };
  });
  ctx.log(`doom.levels: ${page.length} level runs`);
  return { rows: page, next: rows.length > PAGE_SIZE ? String(offset + PAGE_SIZE) : null };
};

/** Minutes and seconds, the way the intermission screen shows a time. */
const clock = (tics: number) => {
  const total = seconds(tics);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
};

/** One level run as a sentence for the recap. */
const levelLine = (r: Row): string => {
  const time = num(r.time_tics);
  const par = r.par_tics === null ? 0 : num(r.par_tics);
  const finished = r.completed_at !== null;
  let line = `${r.map}, attempt ${num(r.attempt)}: ${finished ? "finished" : "not finished"} after ${clock(time)}`;
  if (finished && par > 0) line += ` (par ${clock(par)}, ${time <= par ? "under par" : "over par"})`;
  line +=
    `. Kills ${num(r.kills)}/${num(r.total_kills)}, items ${num(r.items)}/${num(r.total_items)}, ` +
    `hidden areas ${num(r.secrets)}/${num(r.total_secrets)}, deaths ${num(r.deaths)}.`;
  return line;
};

/**
 * The handler behind the recap-my-doom goal. It writes the latest session out in plain words,
 * oldest level first, and leaves the telling to the assistant.
 */
export const recap = async (_input: unknown, ctx: Ctx) => {
  const db = ctx.deps.db;
  const session = (await db.exec("SELECT * FROM sessions ORDER BY started_at DESC LIMIT 1"))[0];
  if (!session) return { summary: "Nobody has played Doom in the doom realm yet." };
  const id = sql(String(session.session_id));
  const runs = await db.exec(`SELECT * FROM levels WHERE session_id = ${id} ORDER BY started_at LIMIT 200`);
  const died = await db.exec(`SELECT * FROM deaths WHERE session_id = ${id} ORDER BY died_at LIMIT 200`);
  const header =
    `Latest Doom session, started ${session.started_at}, on "${SKILLS[num(session.skill)] ?? "unknown"}".` +
    ` Last seen on ${session.last_map ?? "no map"} with ${num(session.health)}% health, ${num(session.armor)}% armor` +
    ` and the ${session.weapon ?? "fist"} in hand.`;
  const guide =
    "Tell the owner how the run went: which levels they finished and how they did against par, what they left behind, where they kept dying, and one thing to try next time.";
  const deathLines = died.map(
    (d) => `Died on ${d.map} at ${clock(num(d.time_tics))} with ${num(d.kills)} kills, holding the ${d.weapon ?? "fist"}.`,
  );
  const standings = standingLines(await boards(db));
  ctx.log(`doom.recap: ${runs.length} level runs, ${died.length} deaths`);
  return { summary: [header, guide, ...runs.map(levelLine), ...deathLines, ...standings].join("\n") };
};

// ── Sharing stats with friends ───────────────────────────────────────────────
//
// The sandbox has no network, so stats travel as a card: a short code holding one player's best
// run of every level. You send yours to a friend however you like, they paste it into their own
// Doom app, and both of you see the same scoreboard. Nothing checks a card is honest. It is for
// playing against people you know.

/**
 * A player's best on one level at one skill. The time and the counts come from one run: the fastest
 * finished one, or the most recent run when the level was never finished.
 */
interface Best {
  map: string;
  skill: number;
  /** The fastest finished run, in tics. Null when the level was never finished. */
  bestTics: number | null;
  parTics: number | null;
  kills: number;
  totalKills: number;
  items: number;
  totalItems: number;
  secrets: number;
  totalSecrets: number;
  deaths: number;
  /** How many times the level was finished. */
  runs: number;
}

interface Player {
  playerId: string;
  name: string;
  isOwner: boolean;
  /** When the card was made, for a friend. Null for the owner, whose numbers are live. */
  cardAt: string | null;
  bests: Best[];
}

const CARD_PREFIX = "DOOM1-";
const MAX_CARD_CHARS = 12_000;
const MAX_BESTS = 64;
const MAX_FRIENDS = 32;
const PLAYER_ID = /^[a-z0-9]{8,32}$/;
const MAP_NAME = /^E[1-9]M[1-9]$/;
/** What the owner is called before they have made a card. */
const UNNAMED = "You";
const UNNAMED_ID = "you";

/** The tables behind cards and friends. They are made here because db/schema.sql can't change: the host ties a realm's saved database to that file's hash. */
const ensureFriendTables = async (db: Db) => {
  await db.exec("CREATE TABLE IF NOT EXISTS profile (id INTEGER PRIMARY KEY CHECK (id = 1), player_id TEXT NOT NULL, name TEXT NOT NULL)");
  await db.exec("CREATE TABLE IF NOT EXISTS friends (player_id TEXT PRIMARY KEY, name TEXT NOT NULL, card_at TEXT NOT NULL, imported_at TEXT NOT NULL)");
  await db.exec(
    "CREATE TABLE IF NOT EXISTS friend_bests (player_id TEXT NOT NULL, map TEXT NOT NULL, skill INTEGER NOT NULL, best_tics INTEGER NULL, par_tics INTEGER NULL, " +
      "kills INTEGER NOT NULL, total_kills INTEGER NOT NULL, items INTEGER NOT NULL, total_items INTEGER NOT NULL, secrets INTEGER NOT NULL, total_secrets INTEGER NOT NULL, " +
      "deaths INTEGER NOT NULL, runs INTEGER NOT NULL, PRIMARY KEY (player_id, map, skill))",
  );
};

const BASE64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/** URL-safe base64 of plain ASCII text. The Wasm runtime has no btoa, so it is done by hand. */
const encode64 = (ascii: string): string => {
  let out = "";
  for (let i = 0; i < ascii.length; i += 3) {
    const a = ascii.charCodeAt(i);
    const b = i + 1 < ascii.length ? ascii.charCodeAt(i + 1) : 0;
    const c = i + 2 < ascii.length ? ascii.charCodeAt(i + 2) : 0;
    out += BASE64[a >> 2] + BASE64[((a & 3) << 4) | (b >> 4)];
    if (i + 1 < ascii.length) out += BASE64[((b & 15) << 2) | (c >> 6)];
    if (i + 2 < ascii.length) out += BASE64[c & 63];
  }
  return out;
};

const decode64 = (text: string): string => {
  let out = "";
  let bits = 0;
  let held = 0;
  for (const char of text) {
    const value = BASE64.indexOf(char);
    if (value < 0) throw new Error("That isn't a Doom card");
    held = (held << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out += String.fromCharCode((held >> bits) & 0xff);
    }
  }
  return out;
};

/** A small sum over the code's text. It catches a card that lost characters in a copy and paste. */
const checksum = (text: string): string => {
  let sum = 0;
  for (let i = 0; i < text.length; i++) sum = (sum * 31 + text.charCodeAt(i)) & 0xffff;
  return sum.toString(16).padStart(4, "0");
};

/** Characters that are invisible or change the direction of the text around them. */
const HIDING = /[\u0080-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/;
/** Half of a surrogate pair with its other half missing. */
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

/**
 * A display name: 1 to 24 characters, trimmed. It can't carry control characters, or anything that
 * would let a friend's name hide or reorder the text shown next to it.
 */
const playerName = (value: unknown): string => {
  if (typeof value !== "string" || HIDING.test(value) || LONE_SURROGATE.test(value)) throw new Error("Invalid name");
  const name = value.trim().replace(/\s+/g, " ");
  if (name.length < 1 || name.length > 24 || /[\u0000-\u001f\u007f]/.test(name)) throw new Error("Invalid name");
  return name;
};

const nullableInt = (value: unknown, max: number, name: string): number | null =>
  value === null ? null : int(value, 0, max, name);

/** One row of a card, checked field by field. Cards come from other people. */
const bestIn = (value: unknown): Best => {
  if (!Array.isArray(value) || value.length !== 12) throw new Error("That isn't a Doom card");
  const [map, skill, bestTics, parTics, kills, totalKills, items, totalItems, secrets, totalSecrets, deaths, runs] = value;
  if (typeof map !== "string" || !MAP_NAME.test(map)) throw new Error("That isn't a Doom card");
  const big = 100_000_000;
  return {
    map,
    skill: int(skill, 0, 4, "skill"),
    bestTics: nullableInt(bestTics, big, "time"),
    parTics: nullableInt(parTics, big, "par"),
    kills: int(kills, 0, 100_000, "kills"),
    totalKills: int(totalKills, 0, 100_000, "totalKills"),
    items: int(items, 0, 100_000, "items"),
    totalItems: int(totalItems, 0, 100_000, "totalItems"),
    secrets: int(secrets, 0, 100_000, "secrets"),
    totalSecrets: int(totalSecrets, 0, 100_000, "totalSecrets"),
    deaths: int(deaths, 0, 1_000_000, "deaths"),
    runs: int(runs, 0, 1_000_000, "runs"),
  };
};

const bestOut = (b: Best) => [b.map, b.skill, b.bestTics, b.parTics, b.kills, b.totalKills, b.items, b.totalItems, b.secrets, b.totalSecrets, b.deaths, b.runs];

const bestFromRow = (r: Row): Best => ({
  map: String(r.map),
  skill: num(r.skill),
  bestTics: r.best_tics === null ? null : num(r.best_tics),
  parTics: r.par_tics === null ? null : num(r.par_tics),
  kills: num(r.kills),
  totalKills: num(r.total_kills),
  items: num(r.items),
  totalItems: num(r.total_items),
  secrets: num(r.secrets),
  totalSecrets: num(r.total_secrets),
  deaths: num(r.deaths),
  runs: num(r.runs),
});

/**
 * The owner's best on every level they have played, worked out from their level runs. Each level
 * and skill picks one run: finished runs first, the fastest of them, and among equal times the
 * most recent. Its time and counts make the best. Deaths add up over every run.
 */
const ownBests = async (db: Db): Promise<Best[]> => {
  const level = "PARTITION BY map, skill";
  const rows = await db.exec(
    "SELECT map, skill, CASE WHEN completed_at IS NOT NULL THEN time_tics END AS best_tics, level_par AS par_tics, " +
      "kills, total_kills, items, total_items, secrets, total_secrets, all_deaths AS deaths, finished AS runs FROM (" +
      `SELECT *, ROW_NUMBER() OVER (${level} ORDER BY completed_at IS NULL, CASE WHEN completed_at IS NOT NULL THEN time_tics END, started_at DESC, rowid DESC) AS pick, ` +
      `MAX(par_tics) OVER (${level}) AS level_par, SUM(deaths) OVER (${level}) AS all_deaths, ` +
      `SUM(CASE WHEN completed_at IS NOT NULL THEN 1 ELSE 0 END) OVER (${level}) AS finished FROM levels` +
      `) WHERE pick = 1 ORDER BY map, skill LIMIT ${MAX_BESTS}`,
  );
  return rows.map(bestFromRow);
};

const ownProfile = async (db: Db) => {
  const row = (await db.exec("SELECT player_id, name FROM profile WHERE id = 1"))[0];
  return row ? { playerId: String(row.player_id), name: String(row.name) } : null;
};

/** The owner and every friend whose card was added, each with their bests. The owner comes first. */
const boards = async (db: Db): Promise<Player[]> => {
  await ensureFriendTables(db);
  const me = await ownProfile(db);
  const players: Player[] = [
    { playerId: me?.playerId ?? UNNAMED_ID, name: me?.name ?? UNNAMED, isOwner: true, cardAt: null, bests: await ownBests(db) },
  ];
  const friends = await db.exec(`SELECT player_id, name, card_at FROM friends ORDER BY name LIMIT ${MAX_FRIENDS}`);
  const theirs = await db.exec(`SELECT * FROM friend_bests ORDER BY map, skill LIMIT ${MAX_FRIENDS * MAX_BESTS}`);
  for (const f of friends) {
    players.push({
      playerId: String(f.player_id),
      name: String(f.name),
      isOwner: false,
      cardAt: String(f.card_at),
      bests: theirs.filter((r) => r.player_id === f.player_id).map(bestFromRow),
    });
  }
  return players;
};

/** The medals a best earns, named after the ones an arena shooter hands out. */
const awards = (b: Best): string[] => {
  const earned: string[] = [];
  if (b.bestTics === null) return earned;
  const all = (part: number, whole: number) => whole > 0 && part >= whole;
  if (b.parTics !== null && b.parTics > 0 && b.bestTics <= b.parTics) earned.push("Impressive");
  if (all(b.kills, b.totalKills)) earned.push("Excellent");
  if (all(b.kills, b.totalKills) && all(b.items, b.totalItems) && all(b.secrets, b.totalSecrets)) earned.push("Perfect");
  return earned;
};

interface Standing {
  playerId: string;
  name: string;
  isOwner: boolean;
  best: Best;
  /** Place on this level, 1 for the fastest. Null when the level was never finished. */
  rank: number | null;
}

interface Board {
  map: string;
  skill: number;
  parTics: number | null;
  standings: Standing[];
}

/** One board per level and skill, fastest finished run first, unfinished runs last. */
const levelBoards = (players: Player[]): Board[] => {
  const byLevel = new Map<string, Board>();
  for (const player of players) {
    for (const best of player.bests) {
      const key = `${best.map}/${best.skill}`;
      const board = byLevel.get(key) ?? { map: best.map, skill: best.skill, parTics: null, standings: [] };
      // A par of 0 means the card or run had none.
      if (board.parTics === null && best.parTics !== null && best.parTics > 0) board.parTics = best.parTics;
      board.standings.push({ playerId: player.playerId, name: player.name, isOwner: player.isOwner, best, rank: null });
      byLevel.set(key, board);
    }
  }
  const all = [...byLevel.values()].sort((a, b) => a.map.localeCompare(b.map) || a.skill - b.skill);
  for (const board of all) {
    board.standings.sort((a, b) => (a.best.bestTics ?? Infinity) - (b.best.bestTics ?? Infinity) || a.name.localeCompare(b.name));
    board.standings.forEach((standing, index) => {
      if (standing.best.bestTics === null) return;
      const above = board.standings[index - 1];
      // Equal times share a place.
      standing.rank = above && above.best.bestTics === standing.best.bestTics ? above.rank : index + 1;
    });
  }
  return all;
};

/** How many levels a player leads. A level only counts once someone else has finished it too. */
const wins = (all: Board[], playerId: string): number =>
  all.filter((board) => board.standings.filter((s) => s.rank !== null).length > 1 && board.standings.some((s) => s.playerId === playerId && s.rank === 1)).length;

/** The scoreboard as sentences for the recap, one per level somebody else has also finished. */
const standingLines = (players: Player[]): string[] => {
  if (players.length < 2) return [];
  const lines = levelBoards(players)
    .filter((board) => board.standings.filter((s) => s.rank !== null).length > 1)
    .map((board) => {
      const timed = board.standings.filter((s) => s.rank !== null);
      // A friend's name is free text from their card, so it goes in quoted.
      return `${board.map} on "${SKILLS[board.skill] ?? "unknown"}": ` + timed.map((s) => `${s.rank}. ${s.isOwner ? "the owner" : JSON.stringify(s.name)} ${clock(s.best.bestTics ?? 0)}`).join(", ") + ".";
    });
  return lines.length === 0 ? [] : ["Against friends whose cards were added, fastest first:", ...lines];
};

/** Something the player got wrong. The page shows the message, so it comes back as a result. */
class Refusal extends Error {}

/**
 * Runs a handler the app calls with player input. The host drops a thrown error's message before
 * it reaches the page, so a refusal comes back as `{ refused }`. Anything else, such as the
 * database failing, still throws: a broken realm must never look like a bad card.
 */
const refusable = async <T extends object>(run: () => Promise<T>): Promise<T | { refused: string }> => {
  try {
    return await run();
  } catch (error) {
    if (error instanceof Refusal) return { refused: error.message };
    throw error;
  }
};

/**
 * Makes the owner's card: a code holding their best run of every level. The first call names the
 * player and fixes their id, so a newer card from the same person replaces their older one.
 */
export const shareCard = (input: { name?: unknown; playerId?: unknown }, ctx: Ctx) => refusable(async () => {
  const db = ctx.deps.db;
  await ensureFriendTables(db);
  let name: string;
  try {
    name = playerName(input?.name);
  } catch {
    throw new Refusal("Invalid name");
  }
  if (typeof input?.playerId !== "string" || !PLAYER_ID.test(input.playerId)) throw new Refusal("Invalid playerId");
  const known = await ownProfile(db);
  // A card that reuses a friend's id would replace that friend on everyone's scoreboard.
  if (!known && (await db.exec(`SELECT player_id FROM friends WHERE player_id = ${sql(input.playerId)}`)).length > 0) {
    throw new Refusal("Invalid playerId");
  }
  const playerId = known?.playerId ?? input.playerId;
  await db.exec(
    `INSERT INTO profile (id, player_id, name) VALUES (1, ${sql(playerId)}, ${sql(name)}) ON CONFLICT(id) DO UPDATE SET name = excluded.name`,
  );
  const bests = await ownBests(db);
  const card = { v: 1, id: playerId, name, at: new Date().toISOString(), bests: bests.map(bestOut) };
  // JSON with everything outside ASCII escaped, so the code is the same bytes on every machine.
  const ascii = JSON.stringify(card).replace(/[\u007f-￿]/g, (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"));
  const body = encode64(ascii);
  ctx.log(`doom.shareCard: ${bests.length} levels`);
  return { code: `${CARD_PREFIX}${body}-${checksum(body)}`, name, playerId, levels: bests.length };
});

/** Adds a friend's card, or replaces the one already held for that player. */
export const importCard = (input: { code?: unknown }, ctx: Ctx) => refusable(async () => {
  const db = ctx.deps.db;
  await ensureFriendTables(db);
  if (typeof input?.code !== "string") throw new Refusal("That isn't a Doom card");
  const code = input.code.replace(/\s+/g, "");
  if (code.length > MAX_CARD_CHARS || !code.startsWith(CARD_PREFIX)) throw new Refusal("That isn't a Doom card");
  const cut = code.lastIndexOf("-");
  const body = code.slice(CARD_PREFIX.length, cut);
  if (cut <= CARD_PREFIX.length || checksum(body) !== code.slice(cut + 1)) {
    throw new Refusal("That card is incomplete. Copy the whole code and try again");
  }
  let card: Record<string, unknown>;
  try {
    card = JSON.parse(decode64(body)) as Record<string, unknown>;
  } catch {
    throw new Refusal("That isn't a Doom card");
  }
  if (typeof card !== "object" || card === null || card.v !== 1) throw new Refusal("That card is from a version this realm can't read");
  if (typeof card.id !== "string" || !PLAYER_ID.test(card.id)) throw new Refusal("That isn't a Doom card");
  if (typeof card.at !== "string" || !/^[0-9T:.Z-]{20,30}$/.test(card.at)) throw new Refusal("That isn't a Doom card");
  if (!Array.isArray(card.bests) || card.bests.length > MAX_BESTS) throw new Refusal("That isn't a Doom card");
  // Whoever pastes a card can't fix one field of it, so any bad field gets the same answer.
  let name: string;
  let bests: Best[];
  try {
    name = playerName(card.name);
    bests = card.bests.map(bestIn);
  } catch {
    throw new Refusal("That isn't a Doom card");
  }
  const playerId = card.id;

  if ((await ownProfile(db))?.playerId === playerId) throw new Refusal("That's your own card");
  const held = await db.exec(`SELECT player_id FROM friends WHERE player_id = ${sql(playerId)}`);
  if (held.length === 0 && num((await db.exec("SELECT COUNT(*) AS n FROM friends"))[0]?.n) >= MAX_FRIENDS) {
    throw new Refusal(`The scoreboard holds ${MAX_FRIENDS} friends. Remove one first`);
  }
  const now = new Date().toISOString();
  await db.exec(
    `INSERT INTO friends (player_id, name, card_at, imported_at) VALUES (${sql(playerId)}, ${sql(name)}, ${sql(card.at)}, ${sql(now)}) ` +
      "ON CONFLICT(player_id) DO UPDATE SET name = excluded.name, card_at = excluded.card_at, imported_at = excluded.imported_at",
  );
  await db.exec(`DELETE FROM friend_bests WHERE player_id = ${sql(playerId)}`);
  for (const b of bests) {
    await db.exec(
      "INSERT OR REPLACE INTO friend_bests (player_id, map, skill, best_tics, par_tics, kills, total_kills, items, total_items, secrets, total_secrets, deaths, runs) VALUES (" +
        `${sql(playerId)}, ${sql(b.map)}, ${b.skill}, ${b.bestTics ?? "NULL"}, ${b.parTics ?? "NULL"}, ${b.kills}, ${b.totalKills}, ${b.items}, ${b.totalItems}, ${b.secrets}, ${b.totalSecrets}, ${b.deaths}, ${b.runs})`,
    );
  }
  ctx.log(`doom.importCard: ${bests.length} levels`);
  return { added: name, playerId, levels: bests.length, replaced: held.length > 0 };
});

/** Takes a friend off the scoreboard. */
export const removeFriend = (input: { playerId?: unknown }, ctx: Ctx) => refusable(async () => {
  const db = ctx.deps.db;
  await ensureFriendTables(db);
  if (typeof input?.playerId !== "string" || !PLAYER_ID.test(input.playerId)) throw new Refusal("Invalid playerId");
  const held = await db.exec(`SELECT player_id FROM friends WHERE player_id = ${sql(input.playerId)}`);
  await db.exec(`DELETE FROM friend_bests WHERE player_id = ${sql(input.playerId)}`);
  await db.exec(`DELETE FROM friends WHERE player_id = ${sql(input.playerId)}`);
  return { removed: held.length > 0 };
});

const playerTotals = (player: Player, all: Board[]) => {
  const finished = player.bests.filter((b) => b.bestTics !== null);
  return {
    playerId: player.playerId,
    name: player.name,
    isOwner: player.isOwner,
    cardDate: player.cardAt,
    wins: wins(all, player.playerId),
    levelsFinished: finished.length,
    levelsUnderPar: finished.filter((b) => awards(b).includes("Impressive")).length,
    deaths: player.bests.reduce((sum, b) => sum + b.deaths, 0),
  };
};

const standingOut = (s: Standing) => ({
  playerId: s.playerId,
  name: s.name,
  isOwner: s.isOwner,
  rank: s.rank,
  finished: s.best.bestTics !== null,
  bestSeconds: s.best.bestTics === null ? null : seconds(s.best.bestTics),
  time: s.best.bestTics === null ? null : clock(s.best.bestTics),
  killPercent: percent(s.best.kills, s.best.totalKills),
  itemPercent: percent(s.best.items, s.best.totalItems),
  hiddenAreaPercent: percent(s.best.secrets, s.best.totalSecrets),
  deaths: s.best.deaths,
  runs: s.best.runs,
  awards: awards(s.best),
});

/** What the app draws: who leads overall, then one board per level. */
export const scoreboard = async (_input: unknown, ctx: Ctx) => {
  const players = await boards(ctx.deps.db);
  const all = levelBoards(players);
  const totals = players.map((p) => playerTotals(p, all)).sort((a, b) => b.wins - a.wins || b.levelsFinished - a.levelsFinished || a.name.localeCompare(b.name));
  return {
    named: players[0].playerId !== UNNAMED_ID,
    players: totals,
    levels: all.map((board) => ({
      map: board.map,
      skill: board.skill,
      skillName: SKILLS[board.skill] ?? "unknown",
      par: board.parTics ? clock(board.parTics) : null,
      standings: board.standings.map(standingOut),
    })),
  };
};

/**
 * The producer behind (:AssistantUser)-[:KNOWS_DOOM_PLAYER]->(:DoomPlayer): the owner and every
 * friend whose card was added.
 */
export const players = async (input: { username?: unknown; cursor?: unknown }, ctx: Ctx) => {
  const usernames = producerKeys(input?.username);
  const offset = offsetCursor(input?.cursor);
  const everyone = await boards(ctx.deps.db);
  const all = levelBoards(everyone);
  const rows = everyone.flatMap((p) => usernames.map((username) => ({ ...playerTotals(p, all), username })));
  ctx.log(`doom.players: ${everyone.length} players`);
  return { rows: rows.slice(offset, offset + PAGE_SIZE), next: rows.length > offset + PAGE_SIZE ? String(offset + PAGE_SIZE) : null };
};

/**
 * The producer behind (:DoomPlayer)-[:HAS_BEST]->(:DoomBest): each player's best on every level,
 * with their place on that level's board.
 */
export const bests = async (input: { playerId?: unknown; cursor?: unknown; map?: unknown }, ctx: Ctx) => {
  const playerIds = new Set(producerKeys(input?.playerId));
  const offset = offsetCursor(input?.cursor);
  const maps = pushed(input?.map);
  const rows = levelBoards(await boards(ctx.deps.db))
    .filter((board) => maps === undefined || maps.includes(board.map))
    .flatMap((board) =>
      board.standings
        .filter((s) => playerIds.has(s.playerId))
        .map((s) => {
          const { name, isOwner, time, ...numbers } = standingOut(s);
          return {
            bestId: `${s.playerId}-${board.map.toLowerCase()}-${board.skill}`,
            ...numbers,
            playerName: name,
            map: board.map,
            skill: board.skill,
            skillName: SKILLS[board.skill] ?? "unknown",
            parSeconds: board.parTics ? seconds(board.parTics) : null,
            underPar: awards(s.best).includes("Impressive"),
          };
        }),
    );
  ctx.log(`doom.bests: ${rows.length} bests`);
  return { rows: rows.slice(offset, offset + PAGE_SIZE), next: rows.length > offset + PAGE_SIZE ? String(offset + PAGE_SIZE) : null };
};
