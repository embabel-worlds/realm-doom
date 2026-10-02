// SPDX-License-Identifier: GPL-2.0-or-later
//
// doomgeneric platform layer for a realm browser app: no SDL, no files but the WAD in MEMFS.
// The page draws frames and feeds keys; this side only queues keys and hands frames over.

#include "doomgeneric.h"

#include <stdint.h>
#include <emscripten.h>

#include "doomstat.h"
#include "d_items.h"

#define KEYQUEUE_SIZE 64

static unsigned short queue[KEYQUEUE_SIZE];
static unsigned int writeAt = 0;
static unsigned int readAt = 0;

EM_JS(void, js_draw_frame, (const uint32_t* pixels, int width, int height), {
  Module.drawFrame(pixels, width, height);
});

EMSCRIPTEN_KEEPALIVE void dg_push_key(int pressed, int key)
{
  queue[writeAt] = (unsigned short)(((pressed ? 1 : 0) << 8) | (key & 0xFF));
  writeAt = (writeAt + 1) % KEYQUEUE_SIZE;
}

// How many numbers dg_stats fills in. The page reads them in this order.
#define STATS_COUNT 20

static int stats[STATS_COUNT];

// A snapshot of the game for the page's stats strip and the realm's history. The page reads the
// numbers straight out of Wasm memory at the returned address. Times are in tics, 35 a second.
EMSCRIPTEN_KEEPALIVE int* dg_stats(void)
{
  player_t* player = &players[consoleplayer];
  weapontype_t weapon = player->readyweapon;
  int ammoType = weapon < NUMWEAPONS ? weaponinfo[weapon].ammo : am_noammo;

  stats[0] = gamestate;
  stats[1] = demoplayback;
  stats[2] = usergame;
  stats[3] = gameepisode;
  stats[4] = gamemap;
  stats[5] = gameskill;
  stats[6] = leveltime;
  stats[7] = player->killcount;
  stats[8] = totalkills;
  stats[9] = player->itemcount;
  stats[10] = totalitems;
  stats[11] = player->secretcount;
  stats[12] = totalsecret;
  stats[13] = player->health;
  stats[14] = player->armorpoints;
  stats[15] = weapon;
  stats[16] = ammoType < NUMAMMO ? player->ammo[ammoType] : -1;
  stats[17] = player->playerstate;
  stats[18] = wminfo.partime;
  stats[19] = paused || menuactive;
  return stats;
}

void DG_Init() {}

void DG_DrawFrame()
{
  js_draw_frame(DG_ScreenBuffer, DOOMGENERIC_RESX, DOOMGENERIC_RESY);
}

void DG_SleepMs(uint32_t ms) {}

uint32_t DG_GetTicksMs()
{
  return (uint32_t)emscripten_get_now();
}

int DG_GetKey(int* pressed, unsigned char* key)
{
  if (readAt == writeAt) return 0;
  unsigned short data = queue[readAt];
  readAt = (readAt + 1) % KEYQUEUE_SIZE;
  *pressed = data >> 8;
  *key = data & 0xFF;
  return 1;
}

void DG_SetWindowTitle(const char* title) {}

int main(int argc, char** argv)
{
  doomgeneric_Create(argc, argv);
  emscripten_set_main_loop(doomgeneric_Tick, 0, 1);
  return 0;
}
