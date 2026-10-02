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

  // The friends scoreboard. Names and numbers in it come from cards other people made, so every
  // node is built with createElement and textContent and nothing here is ever read as markup.
  function scoreboard() {
    const nameInput = document.getElementById('player-name');
    const makeButton = document.getElementById('make-card');
    const cardBox = document.getElementById('my-card-box');
    const myCard = document.getElementById('my-card');
    const copyButton = document.getElementById('copy-card');
    const friendCard = document.getElementById('friend-card');
    const addButton = document.getElementById('add-friend');
    const status = document.getElementById('board-status');
    const standings = document.getElementById('standings');
    const levels = document.getElementById('levels');
    const DASH = '–';

    const el = (tag, text, className) => {
      const node = document.createElement(tag);
      if (text !== undefined && text !== null) node.textContent = String(text);
      if (className) node.className = className;
      return node;
    };
    const say = (text, isError) => {
      status.textContent = text;
      status.classList.toggle('error', Boolean(isError));
    };
    const reason = (error) => (error && error.message ? error.message : String(error));

    // A table inside its own box, so a wide board scrolls sideways instead of the page.
    const table = (headings, captionText) => {
      const node = el('table');
      if (captionText) node.append(el('caption', captionText));
      const head = el('tr');
      for (const heading of headings) {
        const th = el('th', heading);
        th.scope = 'col';
        head.append(th);
      }
      const thead = el('thead');
      thead.append(head);
      const body = el('tbody');
      node.append(thead, body);
      const box = el('div', null, 'table-box');
      box.append(node);
      return { box, body };
    };

    const row = (cells, className) => {
      const tr = el('tr', null, className);
      for (const cell of cells) {
        if (cell instanceof Node) {
          const td = el('td');
          td.append(cell);
          tr.append(td);
        } else {
          tr.append(el('td', cell));
        }
      }
      return tr;
    };

    const playerCell = (entry) => {
      const span = el('span', null, 'who');
      span.append(el('span', entry.name));
      if (entry.isOwner) span.append(el('span', 'you', 'you'));
      return span;
    };

    const removeButton = (player) => {
      const button = el('button', 'Remove', 'remove');
      button.type = 'button';
      button.setAttribute('aria-label', 'Remove ' + player.name);
      button.addEventListener('click', () => {
        button.disabled = true;
        call('doom.removeFriend', { playerId: player.playerId })
          .then(() => {
            say('Removed ' + player.name);
            return refresh();
          })
          .catch((error) => {
            button.disabled = false;
            say(reason(error), true);
          });
      });
      return button;
    };

    const drawStandings = (players) => {
      const { box, body } = table(['Player', 'Wins', 'Levels', 'Under par', 'Deaths', '']);
      players.forEach((p, i) => {
        // Only a leader with a win gets the highlight, so a board of all zeroes has no leader.
        const classes = [i === 0 && p.wins > 0 ? 'leader' : '', p.isOwner ? 'mine' : ''].join(' ').trim();
        body.append(row([
          playerCell(p), p.wins, p.levelsFinished, p.levelsUnderPar, p.deaths,
          p.isOwner ? '' : removeButton(p),
        ], classes));
      });
      standings.replaceChildren(box);
    };

    const medals = (awards) => {
      const span = el('span', null, 'medals');
      for (const award of awards || []) span.append(el('span', award, 'medal'));
      return span;
    };

    const drawLevels = (boards) => {
      if (boards.length === 0) {
        levels.replaceChildren(el('p', 'Finish a level to get on the board.', 'empty'));
        return;
      }
      const tables = boards.map((level) => {
        const caption = level.map + ' · ' + level.skillName + (level.par ? ' · par ' + level.par : '');
        const { box, body } = table(['#', 'Player', 'Time', 'Kills', 'Items', 'Secrets', 'Deaths', 'Medals'], caption);
        for (const s of level.standings) {
          const done = s.finished && s.time !== null;
          const classes = [done && s.rank === 1 ? 'top' : '', s.isOwner ? 'mine' : ''].join(' ').trim();
          body.append(row([
            done && s.rank !== null ? s.rank : DASH, playerCell(s), done ? s.time : DASH,
            s.killPercent + '%', s.itemPercent + '%', s.hiddenAreaPercent + '%', s.deaths, medals(s.awards),
          ], classes));
        }
        return box;
      });
      levels.replaceChildren(...tables);
    };

    const refresh = () => call('doom.scoreboard', {})
      .then((r) => {
        if (!r) return;
        drawStandings(r.players || []);
        drawLevels(r.levels || []);
        const me = (r.players || []).find((p) => p.isOwner);
        if (r.named && me && !nameInput.value && document.activeElement !== nameInput) nameInput.value = me.name;
      })
      .catch((error) => say('The scoreboard is not available: ' + reason(error), true));

    // 16 characters from [a-z0-9]. Bytes of 252 and up are skipped so every character is equally likely.
    const newPlayerId = () => {
      const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
      let id = '';
      while (id.length < 16) {
        for (const b of crypto.getRandomValues(new Uint8Array(32))) {
          if (b < 252 && id.length < 16) id += alphabet[b % 36];
        }
      }
      return id;
    };

    makeButton.addEventListener('click', () => {
      const name = nameInput.value.trim();
      if (!name) {
        say('Type your name first.', true);
        nameInput.focus();
        return;
      }
      makeButton.disabled = true;
      call('doom.shareCard', { name, playerId: newPlayerId() })
        .then((r) => {
          myCard.value = r.code;
          cardBox.hidden = false;
          nameInput.value = r.name;
          say('Your card holds ' + r.levels + (r.levels === 1 ? ' level' : ' levels') + '. Copy it and send it to a friend.');
          return refresh();
        })
        .catch((error) => say(reason(error), true))
        .finally(() => { makeButton.disabled = false; });
    });

    // The frame may refuse the clipboard. Then the code is selected so the player can copy it by hand.
    copyButton.addEventListener('click', () => {
      const byHand = () => {
        myCard.focus();
        myCard.select();
        say('The browser would not copy it here. The card is selected: press Ctrl+C or Cmd+C to copy it.');
      };
      try {
        if (!navigator.clipboard || !navigator.clipboard.writeText) throw new Error('no clipboard');
        navigator.clipboard.writeText(myCard.value).then(() => say('Copied. Send it to a friend.'), byHand);
      } catch (error) {
        byHand();
      }
    });

    addButton.addEventListener('click', () => {
      const code = friendCard.value.trim();
      if (!code) {
        say("Paste a friend's card first.", true);
        friendCard.focus();
        return;
      }
      addButton.disabled = true;
      call('doom.importCard', { code })
        .then((r) => {
          friendCard.value = '';
          say((r.replaced ? 'Updated ' : 'Added ') + r.added);
          return refresh();
        })
        .catch((error) => say(reason(error), true))
        .finally(() => { addButton.disabled = false; });
    });

    return { refresh };
  }

  // Watches the game, turns what it sees into events, and keeps the stats strip current.
  function trackStats(doom, onSaved) {
    const strip = document.getElementById('stats');
    const saved = document.getElementById('saved');
    const sessionId = 's' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
    let before = null;
    let lastSnapshot = 0;

    const send = (event, s, droppable) => {
      call('doom.record', { sessionId, event, stats: forRealm(s) }, droppable)
        .then((r) => {
          // A finished level or a death can change the boards, so redraw once it is saved.
          if (r && (event === 'levelComplete' || event === 'death')) onSaved();
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

    // The scoreboard works on its own, so it is up even if the engine fails to load.
    const board = scoreboard();
    board.refresh();

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

    trackStats(doom, board.refresh);
    doom.callMain(['-iwad', '/doom1.wad']);
  }

  const run = () => start().catch((error) => {
    document.getElementById('status').textContent = 'Doom failed to start: ' + error.message;
  });
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', run);
  else run();
})();
