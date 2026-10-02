# doom

Doom, shareware episode one, in a realm browser app. The engine runs as Wasm inside the app's
sandboxed frame. While you play, the app reads kills, items, secrets and health out of the engine
and sends them to the realm, which keeps them in its own SQLite and puts sessions and levels in
the graph:

```cypher
MATCH (u:AssistantUser)-[:PLAYED_DOOM]->(s:DoomSession)-[:HAS_LEVEL]->(l:DoomLevel)
RETURN s.startedAt, l.map, l.kills, l.totalKills, l.timeSeconds, l.underPar
```

## What's in here

| Path | What it is |
|---|---|
| `realm.yml`, `producers/`, `dist/`, `dependencies/`, `apps/doom.html.app.json` | What the appliance installs. Written by synth from `realm.ts`; don't edit by hand. |
| `realm.ts` | The realm: `doom.welcome`, `doom.record`, the two producers, the SQLite dependency and the app. |
| `wasm/handlers.ts` | The handlers. `record` saves game events; `sessions` and `levels` feed the producers. |
| `db/schema.sql` | The tables behind sessions and levels. |
| `apps/doom.html` | The page: the screen, a stats strip and the key hints. |
| `apps/doom.html.assets/app.js`, `app.css` | The app code and styles. |
| `apps/doom.html.assets/engine.js` | The engine, Wasm inlined. Written by `build.sh`. |
| `apps/doom.html.assets/wad.js` | The shareware `DOOM1.WAD` as base64. |
| `engine/doomgeneric_realm.c` | The platform layer: frames out to the page, keys in, and `dg_stats`. |
| `engine/srcs.txt` | The engine sources that get compiled. |
| `build.sh` | Clones the engine at a pinned commit and compiles it with Emscripten. |
| `icon.svg` | The realm's icon. |

## What the appliance needs

- Wasm realms switched on: `ASSISTANT_REALMLOADER_ADMISSIONENABLED=true`.
- The `sqlite3-wasi` 3.53 module in the appliance's Wasm dependency store
  (sha256 `9a5542e25e42fbbb48501bae0ab4295cdf0fd0f41219ec3b6c891c4a282e7779`).
- Nothing else. The app's page and assets come to about 6 MB, inside the appliance's default
  10 MiB limit for a realm browser app.

## Rebuilding the engine

```bash
./build.sh
```

Needs git and Emscripten. It clones [doomgeneric](https://github.com/ozkl/doomgeneric) at commit
`dcb7a8dbc7a16ce3dda29382ac9aae9d77d21284` into `vendor/`, adds `engine/doomgeneric_realm.c` and
writes `apps/doom.html.assets/engine.js`. The engine has no sound.

## Changing the realm

`realm.ts` is the source of truth. After changing it, the handlers, the schema or the app, run the
Embabel realm synth over `realm.ts` to rewrite the installable files at the repo root.

## Licences

- **The engine** is the Doom source as released by id Software, through doomgeneric, under the
  GNU General Public License version 2 or later. `engine/doomgeneric_realm.c` is under the same
  licence. The full text is in [LICENSE](LICENSE). `engine.js` is built from exactly the sources
  `build.sh` names, so that script and the pinned commit are the corresponding source.
- **The realm's own code** (`realm.ts`, `wasm/`, `db/`, the app's `app.js`, `app.css` and
  `doom.html`, and `icon.svg`) is under the same GPL, because the app runs as one program with
  the engine.
- **`DOOM1.WAD`** is id Software's shareware game data, version 1.9, unmodified
  (sha1 `5b2e249b9c5133ec987b3ea77596381dc0d6bc1d`). It is not GPL. id Software allows the
  shareware version to be passed on free of charge, and it stays their copyright. The registered
  and retail WADs are not redistributable and are not here.

Doom is a trademark of id Software. This realm is not affiliated with or endorsed by them.
