(() => {
  const KEYS = {
    ArrowLeft: 0xac, ArrowRight: 0xae, ArrowUp: 0xad, ArrowDown: 0xaf,
    Enter: 13, Escape: 27, Tab: 9, Backspace: 0x7f, Space: 0xa2,
    ControlLeft: 0xa3, ControlRight: 0xa3, KeyF: 0xa3,
    ShiftLeft: 0x80 + 0x36, ShiftRight: 0x80 + 0x36,
    AltLeft: 0x80 + 0x38, AltRight: 0x80 + 0x38,
    Comma: 0xa0, Period: 0xa1, Equal: 0x3d, Minus: 0x2d,
    F1: 0x80 + 0x3b, F2: 0x80 + 0x3c, F3: 0x80 + 0x3d, F4: 0x80 + 0x3e, F5: 0x80 + 0x3f,
    F6: 0x80 + 0x40, F7: 0x80 + 0x41, F8: 0x80 + 0x42, F9: 0x80 + 0x43, F10: 0x80 + 0x44,
    F11: 0x80 + 0x57, Pause: 0xff,
  };

  function doomKey(event) {
    if (event.code in KEYS) return KEYS[event.code];
    if (event.key.length === 1) {
      const code = event.key.toLowerCase().charCodeAt(0);
      if (code >= 32 && code < 127) return code;
    }
    return 0;
  }

  const WEAPONS = ['Fist', 'Pistol', 'Shotgun', 'Chaingun', 'Rockets', 'Plasma', 'BFG', 'Chainsaw', 'Super shotgun'];
  const SKILLS = ['ITYTD', 'HNTR', 'HMP', 'UV', 'NM'];
  const GS_LEVEL = 0, GS_INTERMISSION = 1, GS_FINALE = 2;
  const PST_DEAD = 1;
  const TICRATE = 35;

  // The host lets only one realm.call run at a time, so every call waits its turn here.
  // Snapshots are dropped while the line is long, since a newer one is always coming.
  let line = Promise.resolve();
  let waiting = 0;
  function call(handler, args, droppable) {
    if (droppable && waiting > 2) return Promise.resolve(null);
    waiting++;
    const result = line.then(() => realm.call(handler, args));
    line = result.catch(() => {}).then(() => { waiting--; });
    return result;
  }

  // The engine fills 20 numbers and hands back where they are in Wasm memory.
  function readStats(doom) {
    const pointer = doom._dg_stats();
    const v = new Int32Array(doom.HEAPU8.buffer, pointer, 20);
    return {
      gamestate: v[0], demo: v[1] !== 0, usergame: v[2] !== 0,
      episode: v[3], map: v[4], skill: v[5], levelTime: v[6],
      kills: v[7], totalKills: v[8], items: v[9], totalItems: v[10],
      secrets: v[11], totalSecrets: v[12], health: v[13], armor: v[14],
      weapon: v[15], ammo: v[16], playerState: v[17], parTime: v[18], paused: v[19] !== 0,
    };
  }

  // Just the numbers the realm keeps, in the form doom.record checks for.
  function forRealm(s) {
    const { episode, map, skill, levelTime, kills, totalKills, items, totalItems,
      secrets, totalSecrets, health, armor, weapon, ammo, parTime } = s;
    return { episode, map, skill, levelTime, kills, totalKills, items, totalItems,
      secrets, totalSecrets, health, armor, weapon, ammo, parTime };
  }

  const clock = (tics) => {
    const total = Math.floor(tics / TICRATE);
    return Math.floor(total / 60) + ':' + String(total % 60).padStart(2, '0');
  };

  // Watches the game, turns what it sees into events, and keeps the stats strip current.
  function trackStats(doom) {
    const strip = document.getElementById('stats');
    const saved = document.getElementById('saved');
    const sessionId = 's' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
    let before = null;
    let lastSnapshot = 0;

    const send = (event, s, droppable) => {
      call('doom.record', { sessionId, event, stats: forRealm(s) }, droppable)
        .then((r) => {
          if (!r || !r.session) return;
          const t = r.session;
          saved.textContent = 'Saved to the realm: ' + t.levelsCompleted + ' of ' + t.levelsPlayed +
            ' levels done, ' + t.kills + ' kills, ' + t.deaths + ' deaths this session';
          saved.classList.remove('error');
        })
        .catch((error) => {
          saved.textContent = 'Not saving: ' + (error && error.message ? error.message : error);
          saved.classList.add('error');
        });
    };

    const cell = (label, value) => '<span><b>' + label + '</b> ' + value + '</span>';

    setInterval(() => {
      const s = readStats(doom);
      const playing = s.gamestate === GS_LEVEL && !s.demo && s.usergame && s.episode > 0 && s.map > 0;
      const was = before && before.gamestate === GS_LEVEL && !before.demo && before.usergame;

      if (playing) {
        const newLevel = !was || before.episode !== s.episode || before.map !== s.map || s.levelTime < before.levelTime;
        if (newLevel) {
          send('levelStart', s);
          lastSnapshot = Date.now();
        } else if (s.playerState === PST_DEAD && before.playerState !== PST_DEAD) {
          send('death', s);
        } else if (Date.now() - lastSnapshot >= 5000 && !s.paused) {
          send('snapshot', s, true);
          lastSnapshot = Date.now();
        }
        strip.innerHTML =
          cell('E' + s.episode + 'M' + s.map, SKILLS[s.skill] || '') +
          cell('Time', clock(s.levelTime)) +
          cell('Kills', s.kills + '/' + s.totalKills) +
          cell('Items', s.items + '/' + s.totalItems) +
          cell('Secrets', s.secrets + '/' + s.totalSecrets) +
          cell('Health', s.health + '%') +
          cell('Armor', s.armor + '%') +
          cell(WEAPONS[s.weapon] || 'Weapon', s.ammo >= 0 ? s.ammo : '');
      } else if (was && (s.gamestate === GS_INTERMISSION || s.gamestate === GS_FINALE)) {
        // The engine stops the level clock at the exit, so these are the finished numbers.
        send('levelComplete', s);
        strip.innerHTML = cell('E' + s.episode + 'M' + s.map + ' done', clock(s.levelTime)) +
          cell('Par', s.parTime ? clock(s.parTime) : 'n/a') +
          cell('Kills', s.kills + '/' + s.totalKills) +
          cell('Items', s.items + '/' + s.totalItems) +
          cell('Secrets', s.secrets + '/' + s.totalSecrets);
      }
      before = s;
    }, 500);
  }

  function wadBytes() {
    const text = atob(window.DOOM_WAD);
    const bytes = new Uint8Array(text.length);
    for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i);
    return bytes;
  }

  async function start() {
    const status = document.getElementById('status');
    const canvas = document.getElementById('screen');
    const context = canvas.getContext('2d');
    let image = null;

    call('doom.welcome', {}).then((r) => { if (r && r.message) status.textContent = r.message; })
      .catch(() => {});

    const doom = await createDoom({
      print: (text) => console.log(text),
      printErr: (text) => console.warn(text),
      drawFrame(pointer, width, height) {
        if (!image || image.width !== width) image = context.createImageData(width, height);
        const source = doom.HEAPU8.subarray(pointer, pointer + width * height * 4);
        const target = image.data;
        for (let i = 0; i < source.length; i += 4) {
          target[i] = source[i + 2];
          target[i + 1] = source[i + 1];
          target[i + 2] = source[i];
          target[i + 3] = 255;
        }
        context.putImageData(image, 0, 0);
      },
    });

    doom.FS.writeFile('/doom1.wad', wadBytes());
    window.DOOM_WAD = null;

    const push = doom._dg_push_key;
    const handle = (pressed) => (event) => {
      const key = doomKey(event);
      if (!key) return;
      event.preventDefault();
      if (!event.repeat) push(pressed, key);
    };
    canvas.addEventListener('keydown', handle(1));
    canvas.addEventListener('keyup', handle(0));
    canvas.addEventListener('click', () => canvas.focus());
    canvas.focus();

    trackStats(doom);
    doom.callMain(['-iwad', '/doom1.wad']);
  }

  const run = () => start().catch((error) => {
    document.getElementById('status').textContent = 'Doom failed to start: ' + error.message;
  });
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', run);
  else run();
})();
