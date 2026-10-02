import { defineRealm } from "@embabel/realm-types";

/**
 * Doom, shareware episode one, running in the realm's browser app.
 *
 * The engine is doomgeneric compiled to Wasm and the WAD is the shareware DOOM1.WAD. Both are
 * inlined into the sandboxed frame, which has no network, so everything the game needs ships in
 * the app's own assets.
 *
 * While you play, the app reads kills, items, secrets, health and the rest out of the engine and
 * sends them to `doom.record`, which keeps them in the realm's own SQLite. Two producers put that
 * history in the graph, so Virtual Cypher can ask about your sessions and every level you played.
 * The `recap-my-doom` goal hands the latest session to the assistant, so you can ask in chat how
 * the run went.
 *
 * Friends compare by card. `doom.shareCard` writes your best run of every level into a short code,
 * a friend adds it with `doom.importCard`, and the scoreboard and two more producers rank
 * everyone level by level. The sandbox has no network, so the code travels however you send it.
 */
export default defineRealm({
  name: "doom",
  host: "wasm",
  version: "0.3.0",
  execution: "captured",
  description: "Doom, shareware episode one, in a realm browser app, with your runs in Virtual Cypher and a scoreboard to share with friends.",
  author: "embabel",
  url: "https://github.com/embabel-worlds/realm-doom",
  tags: ["game", "demo", "scoreboard"],
  icon: "icon.svg",

  handlers: {
    welcome: {
      namespace: "doom",
      description: "A line to show above the game.",
      input: { type: "object", additionalProperties: false, properties: {} },
      output: { type: "object" },
    },
    record: {
      namespace: "doom",
      description:
        "Saves one game event in the realm's SQLite: a periodic snapshot, a level starting, a level finished or the player dying.",
      input: {
        type: "object",
        additionalProperties: false,
        properties: {
          sessionId: { type: "string", minLength: 4, maxLength: 64, description: "The play session, made up by the app on load." },
          event: { type: "string", minLength: 5, maxLength: 16, description: "snapshot, levelStart, levelComplete or death." },
          stats: { type: "object", description: "The numbers read out of the engine at that moment." },
        },
        required: ["sessionId", "event", "stats"],
      },
      output: { type: "object" },
    },
    sessions: {
      namespace: "doom",
      description: "Doom play sessions for the usernames the host names, newest first, with totals across their levels.",
      input: {
        type: "object",
        additionalProperties: false,
        properties: {
          username: {
            type: "array",
            minItems: 1,
            maxItems: 256,
            items: { type: "string", minLength: 1, maxLength: 256 },
            description: "The AssistantUser usernames the host is fetching for.",
          },
          cursor: { type: "string", description: "This realm's own next cursor, resent by the host." },
          skillName: {
            type: "array",
            maxItems: 64,
            items: { type: "string", maxLength: 64 },
            description: "Only sessions at these skill levels, when the query filters on skillName.",
          },
        },
        required: ["username"],
      },
      output: { type: "object" },
    },
    levels: {
      namespace: "doom",
      description: "Every level run in the sessions the host names: time, par, kills, items, secrets and deaths.",
      input: {
        type: "object",
        additionalProperties: false,
        properties: {
          sessionId: {
            type: "array",
            minItems: 1,
            maxItems: 256,
            items: { type: "string", minLength: 1, maxLength: 256 },
            description: "The DoomSession ids the host is fetching for.",
          },
          cursor: { type: "string", description: "This realm's own next cursor, resent by the host." },
          map: {
            type: "array",
            maxItems: 64,
            items: { type: "string", maxLength: 16 },
            description: "Only runs of these maps, such as E1M1, when the query filters on map.",
          },
        },
        required: ["sessionId"],
      },
      output: { type: "object" },
    },
    shareCard: {
      namespace: "doom",
      description: "Makes the owner's card: a code holding their best run of every level, to send to a friend.",
      input: {
        type: "object",
        additionalProperties: false,
        properties: {
          name: { type: "string", minLength: 1, maxLength: 24, description: "The name friends will see on their scoreboard." },
          playerId: { type: "string", minLength: 8, maxLength: 32, description: "An id the app makes up. The realm keeps the first one it is given." },
        },
        required: ["name", "playerId"],
      },
      output: { type: "object" },
    },
    importCard: {
      namespace: "doom",
      description: "Adds a friend's card to the scoreboard, or replaces the one already held for that player.",
      input: {
        type: "object",
        additionalProperties: false,
        properties: {
          code: { type: "string", minLength: 1, maxLength: 16000, description: "The code a friend's Doom app made." },
        },
        required: ["code"],
      },
      output: { type: "object" },
    },
    removeFriend: {
      namespace: "doom",
      description: "Takes a friend off the scoreboard.",
      input: {
        type: "object",
        additionalProperties: false,
        properties: {
          playerId: { type: "string", minLength: 8, maxLength: 32, description: "The friend's player id, as the scoreboard lists it." },
        },
        required: ["playerId"],
      },
      output: { type: "object" },
    },
    scoreboard: {
      namespace: "doom",
      description: "Who leads overall, then one board per level: the owner and their friends, fastest first, with the medals each run earned.",
      input: { type: "object", additionalProperties: false, properties: {} },
      output: { type: "object" },
    },
    players: {
      namespace: "doom",
      description: "The owner and every friend whose card was added, with their wins and totals, for the usernames the host names.",
      input: {
        type: "object",
        additionalProperties: false,
        properties: {
          username: {
            type: "array",
            minItems: 1,
            maxItems: 256,
            items: { type: "string", minLength: 1, maxLength: 256 },
            description: "The AssistantUser usernames the host is fetching for.",
          },
          cursor: { type: "string", description: "This realm's own next cursor, resent by the host." },
        },
        required: ["username"],
      },
      output: { type: "object" },
    },
    bests: {
      namespace: "doom",
      description: "Each named player's best on every level, with their place on that level's board.",
      input: {
        type: "object",
        additionalProperties: false,
        properties: {
          playerId: {
            type: "array",
            minItems: 1,
            maxItems: 256,
            items: { type: "string", minLength: 1, maxLength: 256 },
            description: "The DoomPlayer ids the host is fetching for.",
          },
          cursor: { type: "string", description: "This realm's own next cursor, resent by the host." },
          map: {
            type: "array",
            maxItems: 64,
            items: { type: "string", maxLength: 16 },
            description: "Only these maps, such as E1M1, when the query filters on map.",
          },
        },
        required: ["playerId"],
      },
      output: { type: "object" },
    },
    recap: {
      namespace: "doom",
      description:
        "The owner's latest Doom session level by level: time against par, kills, items, hidden areas and every death, so the assistant can say how the run went.",
      output: { type: "object" },
    },
  },

  types: {
    DoomRecap: {
      description: "The owner's latest Doom session, level by level, with every death.",
      visibility: "internal",
      userAnchor: false,
      properties: {
        summary: { type: "string", description: "The session in plain words: each level run, its numbers and where the player died." },
      },
    },
  },

  goals: {
    "recap-my-doom": {
      handler: "doom.recap",
      input: "UserInput",
      output: "DoomRecap",
      description:
        "Recaps the owner's latest Doom session: which levels they finished, how they did against par, what they missed and where they died.",
    },
  },

  producers: {
    "sessions-by-user": {
      handler: "doom.sessions",
      keyArgument: "username",
      joins: [
        {
          targetLabel: "DoomSession",
          anchorLabel: "AssistantUser",
          relationship: "PLAYED_DOOM",
          keyField: "username",
          recordKeyField: "username",
        },
      ],
      page: { argument: "cursor", maxPages: 4 },
      // WHERE s.skillName = 'Ultra-Violence' reaches doom.sessions, which filters in SQLite.
      pushdown: [{ property: "skillName", argument: "skillName" }],
    },
    "levels-by-session": {
      handler: "doom.levels",
      keyArgument: "sessionId",
      joins: [
        {
          targetLabel: "DoomLevel",
          anchorLabel: "DoomSession",
          relationship: "HAS_LEVEL",
          keyField: "sessionId",
          recordKeyField: "sessionId",
        },
      ],
      page: { argument: "cursor", maxPages: 4 },
      // WHERE l.map IN ['E1M1', 'E1M2'] reaches doom.levels, which filters in SQLite.
      pushdown: [{ property: "map", argument: "map" }],
    },
    "players-by-user": {
      handler: "doom.players",
      keyArgument: "username",
      joins: [
        {
          targetLabel: "DoomPlayer",
          anchorLabel: "AssistantUser",
          relationship: "KNOWS_DOOM_PLAYER",
          keyField: "username",
          recordKeyField: "username",
        },
      ],
      page: { argument: "cursor", maxPages: 2 },
    },
    "bests-by-player": {
      handler: "doom.bests",
      keyArgument: "playerId",
      joins: [
        {
          targetLabel: "DoomBest",
          anchorLabel: "DoomPlayer",
          relationship: "HAS_BEST",
          keyField: "playerId",
          recordKeyField: "playerId",
        },
      ],
      page: { argument: "cursor", maxPages: 8 },
      // WHERE b.map = 'E1M1' reaches doom.bests, which leaves the other levels out.
      pushdown: [{ property: "map", argument: "map" }],
    },
  },

  dependencies: {
    /** The realm's own SQLite, kept between calls and across restarts. The tables are in db/schema.sql. */
    db: {
      module: "sqlite3-wasi",
      version: "3.53",
      sha256: "9a5542e25e42fbbb48501bae0ab4295cdf0fd0f41219ec3b6c891c4a282e7779",
      persistent: true,
      init: "db/schema.sql",
    },
  },

  apps: {
    "doom.html": {
      handlers: ["doom.welcome", "doom.record", "doom.shareCard", "doom.importCard", "doom.removeFriend", "doom.scoreboard"],
      resources: [
        "apps/doom.html.assets/app.css",
        "apps/doom.html.assets/engine.js",
        "apps/doom.html.assets/wad.js",
        "apps/doom.html.assets/app.js",
      ],
    },
  },
});
