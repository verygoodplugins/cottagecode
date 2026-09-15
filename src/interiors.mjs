import { prStage } from './pr.mjs';

// World coordinates are pixels. Character coordinates are the center of their feet;
// object bounds are top-left rectangles, with an explicit, reachable approach point.
export const INTERIOR_WIDTH = 240;
export const INTERIOR_HEIGHT = 176;

const INK = '#443729';
const WOOD_DARK = '#715035';
const WOOD = '#aa794c';
const WOOD_LIGHT = '#d6a56b';
const PAPER = '#fff1ce';
const BOOKS = ['#668f89', '#b87056', '#bfa55f', '#8984a1', '#57758b'];
const SKINS = ['#f2c899', '#dfaa78', '#c38d61', '#a96e49', '#845639', '#61412f'];
const HAIR = ['#483227', '#75513a', '#ab7547', '#d3b273', '#cecbc1', '#353137'];
const CLOTHES = ['#5d8597', '#6b9672', '#c08563', '#9a789c', '#ba9b58', '#6c8c8c'];

const PALETTES = [
  { wall: '#eee0bc', wallShade: '#d5c39a', floor: '#bc925f', board: '#c49b6a', grain: '#a67d51', rug: '#77928b', rugDark: '#526d68', trim: '#e1c89b' },
  { wall: '#e3e5c9', wallShade: '#c1c9ab', floor: '#b7895d', board: '#c3956a', grain: '#9e744f', rug: '#ae7568', rugDark: '#85544c', trim: '#f0d49b' },
  { wall: '#ead6c4', wallShade: '#d2bba4', floor: '#b99b70', board: '#c3a779', grain: '#a0855c', rug: '#7b819c', rugDark: '#565d79', trim: '#e9cc9a' },
  { wall: '#e5ddc8', wallShade: '#c7bfa8', floor: '#b78859', board: '#c39362', grain: '#9c6f47', rug: '#a39767', rugDark: '#777147', trim: '#ece0b7' },
];

const THEMES = {
  hub: { label: 'Switchboard cottage', accent: '#658f89', motif: 'pigeonholes' },
  app: { label: 'A little device studio', accent: '#708eaa', motif: 'phones' },
  memory: { label: 'The cottage library', accent: '#849874', motif: 'drawers' },
  vault: { label: 'Clock and lock workshop', accent: '#ad8d61', motif: 'keys' },
  neutral: { label: 'A little home for work', accent: '#b58e61', motif: 'sideboard' },
};

// Furniture stays out of the central circulation area. These are authored plans,
// rather than random placement followed by a best-effort collision repair.
const PLANS = [
  {
    id: 'hearthside', door: 120, window: 72,
    request: [24, 18, 31, 25], clock: [112, 18, 16, 24],
    shelf: [174, 50, 42, 20], workbench: [26, 84, 55, 28], review: [162, 88, 52, 26],
    theme: [72, 51, 32, 20], hearth: [20, 128, 32, 28], chair: [76, 136, 20, 20], plant: [210, 132, 12, 20],
    rug: [89, 87, 62, 49],
  },
  {
    id: 'booknook', door: 144, window: 56,
    request: [100, 18, 31, 25], clock: [181, 18, 16, 24],
    shelf: [20, 50, 42, 20], workbench: [154, 80, 58, 28], review: [31, 92, 49, 26],
    theme: [68, 52, 32, 20], hearth: [190, 128, 32, 28], chair: [84, 134, 20, 20], plant: [19, 134, 12, 20],
    rug: [91, 87, 58, 42],
  },
  {
    id: 'atelier', door: 102, window: 81,
    request: [24, 18, 31, 25], clock: [144, 18, 16, 24],
    shelf: [172, 50, 42, 20], workbench: [20, 100, 57, 28], review: [155, 94, 56, 26],
    theme: [82, 53, 36, 21], hearth: [189, 130, 32, 26], chair: [137, 136, 20, 20], plant: [208, 77, 12, 20],
    rug: [82, 86, 64, 48],
  },
  {
    id: 'longroom', door: 120, window: 143,
    request: [91, 18, 31, 25], clock: [30, 18, 16, 24],
    shelf: [165, 51, 44, 21], workbench: [155, 94, 58, 28], review: [26, 84, 51, 26],
    theme: [66, 52, 33, 20], hearth: [22, 130, 32, 26], chair: [76, 132, 20, 20], plant: [210, 133, 12, 20],
    rug: [86, 82, 62, 47],
  },
];

function hash(text) {
  let h = 2166136261;
  for (const character of text) {
    h ^= character.codePointAt(0);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function random(seed) {
  let state = seed;
  return () => {
    state += 0x6D2B79F5;
    let value = state;
    value = Math.imul(value ^ value >>> 15, value | 1);
    value ^= value + Math.imul(value ^ value >>> 7, value | 61);
    return ((value ^ value >>> 14) >>> 0) / 4294967296;
  };
}

function themeFor(agent) {
  const explicit = agent.interiorTheme ?? agent.theme;
  const raw = String(explicit ?? agent.town ?? '').toLowerCase().replace(/[^a-z]/g, '');
  if (['hub', 'hubtown', 'autohub'].includes(raw)) return 'hub';
  if (['app', 'apptown', 'autoapp'].includes(raw)) return 'app';
  if (['mem', 'memory', 'memtown', 'automem'].includes(raw)) return 'memory';
  if (['vault', 'vaulttown', 'autovault'].includes(raw)) return 'vault';
  return 'neutral';
}

function furniture(id, label, bounds, extra = {}) {
  const [x, y, w, h] = bounds;
  return { id, kind: id, label, x, y, w, h, solid: true, interactable: false, ...extra };
}

// Wall decoration has its own random stream so adding a book or clock never
// reshuffles a room, moves an interaction point, or changes a resident's face.
function createDecor(room) {
  const next = random(room.seed ^ 0x71C04E21);
  const pick = (array) => array[Math.floor(next() * array.length)];
  const occupied = [
    ...room.objects.filter((object) => ['request', 'clock'].includes(object.id)).map((object) => ({ x: object.x - 4, end: object.x + object.w + 4 })),
    { x: room.window.x - 5, end: room.window.x + room.window.w + 5 },
  ].sort((a, b) => a.x - b.x);
  const gaps = [];
  let cursor = 15;
  for (const span of occupied) {
    if (span.x > cursor) gaps.push({ x: cursor, w: span.x - cursor });
    cursor = Math.max(cursor, span.end);
  }
  if (cursor < 225) gaps.push({ x: cursor, w: 225 - cursor });
  const wallPanels = [];
  for (const gap of gaps) {
    if (room.theme === 'memory' && gap.w >= 6) {
      const books = [];
      for (let row = 0; row < 2; row++) {
        for (let x = 2; x < gap.w - 3;) {
          const w = Math.min(2 + Math.floor(next() * 3), gap.w - x - 2);
          const h = 7 + Math.floor(next() * 4);
          books.push({ x, y: 13 + row * 14 - h, w, h, color: pick(BOOKS), band: next() > .4 });
          x += w + 1;
        }
      }
      wallPanels.push({ ...gap, y: 15, h: 29, kind: 'bookcase', books });
    } else if (room.theme === 'vault' && gap.w >= 12) {
      const clocks = [];
      let x = 1;
      while (x + 11 <= gap.w) {
        const style = pick(['round', 'pendulum', 'cuckoo', 'carriage']);
        const w = Math.min(style === 'cuckoo' ? 19 : 13 + Math.floor(next() * 4), gap.w - x - 1);
        clocks.push({ x, y: style === 'round' ? 5 : 0, w, h: style === 'round' ? 17 : 27, style, phase: next() * Math.PI * 2, hands: Math.floor(next() * 4), color: pick([WOOD, '#95704c', '#b09562', '#846b55']) });
        x += w + 4;
      }
      if (clocks.length >= 3) clocks.at(-1).style = 'key-rack';
      wallPanels.push({ ...gap, y: 16, h: 28, kind: 'clock-collection', clocks });
    } else if (room.theme === 'app' && gap.w >= 13) {
      wallPanels.push({ ...gap, y: 17, h: 26, kind: 'device-rack', variant: Math.floor(next() * 3), color: pick(['#86b4b1', '#819cb9', '#bea0aa']), screens: Math.max(1, Math.floor((gap.w - 4) / 11)) });
    }
  }
  return { wallPanels, surfaceVariant: Math.floor(next() * 4), bookStack: Math.floor(next() * 4), deviceColor: pick(['#87c2c4', '#97b6d0', '#a9c3a2']), brass: pick(['#e4c16d', '#d6b47b', '#c6af79']) };
}

/** A task gets a new room; updated text and timestamps never change its seed. */
export function createInterior(agent = {}) {
  const cottage = agent.id ?? agent.sessionId ?? `${agent.town ?? ''}:${agent.name ?? 'cottage'}`;
  const seed = hash(JSON.stringify([String(cottage), agent.taskId == null ? null : String(agent.taskId)]));
  const next = random(seed);
  const pick = (array) => array[Math.floor(next() * array.length)];
  const plan = pick(PLANS);
  const theme = themeFor(agent);
  const palette = { ...pick(PALETTES), accent: THEMES[theme].accent };
  const door = { x: plan.door, y: 154 };
  const objects = [
    furniture('request', 'Original request', plan.request, { solid: false, interactable: true, approach: { x: plan.request[0] + 16, y: 56 } }),
    furniture('clock', 'Task and session clocks', plan.clock, { solid: false, interactable: true, approach: { x: plan.clock[0] + 8, y: 56 } }),
    ...[
      ['shelf', 'Results and artifacts'],
      ['workbench', 'Live activity journal'],
      ['review', 'Pull request and review'],
    ].map(([id, label]) => furniture(id, label, plan[id], {
      interactable: true,
      approach: { x: Math.round((plan[id][0] + plan[id][2] / 2) / 2) * 2, y: Math.ceil((plan[id][1] + plan[id][3] + 8) / 2) * 2 },
    })),
    furniture('theme', THEMES[theme].label, plan.theme, { variant: Math.floor(next() * 4) }),
    furniture('hearth', 'A warm hearth', plan.hearth),
    furniture('chair', 'An armchair and a soft blanket', plan.chair),
    furniture('plant', 'A well-watered plant', plan.plant, { variant: Math.floor(next() * 3) }),
    furniture('exit', 'Back to Townmap', [door.x - 13, 152, 26, 14], { solid: false, interactable: true, approach: { ...door } }),
  ];
  const workbench = objects.find((object) => object.id === 'workbench');
  const resident = {
    skin: pick(SKINS), hair: pick(HAIR), clothing: pick(CLOTHES), trousers: pick(['#4c5963', '#625146', '#5e6260']),
    hairStyle: Math.floor(next() * 4), outfit: Math.floor(next() * 4), headgear: pick(['none', 'none', 'beanie', 'cap', 'headphones', 'flower']),
    accessory: pick(['none', 'glasses', 'scarf']), accent: palette.trim,
    x: workbench.approach.x + 14, y: workbench.approach.y,
  };
  const room = {
    seed, width: INTERIOR_WIDTH, height: INTERIOR_HEIGHT, layout: plan.id,
    theme, themeLabel: THEMES[theme].label, palette, door, objects, resident,
    floor: { x: 14, y: 50, w: 212, h: 110 },
    rug: { x: plan.rug[0], y: plan.rug[1], w: plan.rug[2], h: plan.rug[3], pattern: Math.floor(next() * 3) },
    window: { x: plan.window, y: 18, w: 23, h: 23 },
    bookColors: Array.from({ length: 8 }, () => pick(BOOKS)),
    floorMarks: Array.from({ length: 42 }, () => ({ x: 16 + Math.floor(next() * 206), y: 55 + Math.floor(next() * 100), w: 2 + Math.floor(next() * 5) })),
  };
  room.decor = createDecor(room);
  if (theme === 'app') {
    resident.heldItem = room.decor.surfaceVariant === 0 ? 'tablet' : 'phone';
    palette.rug = ['#6d91a0', '#74979d', '#7986a2', '#718f95'][room.decor.surfaceVariant];
    palette.rugDark = '#4d6b78';
  } else if (theme === 'memory') {
    resident.heldItem = 'book';
    palette.wall = '#d4bf94';
    palette.rug = ['#849875', '#8e9170', '#8b8071', '#a08a69'][room.decor.surfaceVariant];
    palette.rugDark = '#58674b';
  } else if (theme === 'vault') {
    resident.heldItem = ['loupe', 'keyring', 'tool', 'keyring'][room.decor.surfaceVariant];
    resident.outfit = 1;
    resident.accent = '#c6a376';
    palette.rug = ['#a97768', '#9b815f', '#9b7986', '#a5886e'][room.decor.surfaceVariant];
    palette.rugDark = '#77584f';
  }
  if (!isWalkable(room, resident.x, resident.y)) resident.x = workbench.approach.x;
  return room;
}

/** Point collision uses the character's feet, not their hat or drawing bounds. */
export function isWalkable(room, x, y) {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
  const floor = room.floor;
  if (x < floor.x || y < floor.y || x >= floor.x + floor.w || y >= floor.y + floor.h) return false;
  return !room.objects.some((object) => object.solid && x >= object.x && x < object.x + object.w && y >= object.y && y < object.y + object.h);
}

function painter(ctx) {
  return (x, y, w, h, color) => {
    ctx.fillStyle = color;
    ctx.fillRect(Math.round(x), Math.round(y), Math.round(w), Math.round(h));
  };
}

function frame(p, x, y, w, h, fill, edge = INK) {
  p(x, y, w, h, edge);
  p(x + 1, y + 1, w - 2, h - 2, fill);
}

function smallText(ctx, text, x, y, color, size = 5) {
  ctx.fillStyle = color;
  ctx.font = `${size}px "Silkscreen", monospace`;
  ctx.textBaseline = 'top';
  ctx.textAlign = 'left';
  ctx.fillText(text, Math.round(x), Math.round(y));
}

function drawBooks(p, x, y, books) {
  for (const book of books) {
    p(x + book.x, y + book.y, book.w, book.h, book.color);
    p(x + book.x, y + book.y, 1, book.h, '#ffffff1c');
    if (book.band) p(x + book.x, y + book.y + 2, book.w, 1, '#e9dbb5bb');
  }
}

function bookPile(p, x, y, room, count = 3, width = 13) {
  for (let i = 0; i < count; i++) {
    const offset = (i + room.decor.bookStack) % 3;
    p(x + offset, y - i * 3, width - offset, 3, room.bookColors[(i + room.decor.bookStack) % room.bookColors.length]);
    p(x + offset + 1, y + 1 - i * 3, width - offset - 2, 1, '#eadfbd');
  }
}

function openBook(p, x, y, w = 19, h = 11) {
  frame(p, x, y + 1, w, h, '#e8d8b8', '#8c7756');
  p(x + 1, y, w - 2, h - 2, PAPER);
  p(x + Math.floor(w / 2), y + 1, 1, h - 1, '#bca67d');
  for (let row = 0; row < 3; row++) {
    p(x + 3, y + 3 + row * 2, Math.floor(w / 2) - 5, 1, '#b9ae90');
    p(x + Math.floor(w / 2) + 3, y + 3 + row * 2, Math.floor(w / 2) - 5, 1, '#b9ae90');
  }
  p(x + Math.floor(w / 2) + 2, y + h - 1, 1, 4, '#a86253');
}

function phone(p, x, y, color, large = false) {
  const w = large ? 10 : 6, h = large ? 13 : 11;
  frame(p, x, y, w, h, '#384b52');
  p(x + 1, y + 2, w - 2, h - 5, color);
  p(x + 2, y + 3, 2, 2, '#d0e8d5');
  if (large) p(x + 5, y + 3, 2, 2, '#e0c698');
  p(x + Math.floor(w / 2), y + h - 2, 1, 1, '#c9d8cc');
}

function decorativeClock(p, x, y, clock, time, brass) {
  const { w, h, style, color } = clock;
  const mid = x + Math.floor(w / 2);
  if (style === 'key-rack') {
    frame(p, x + 1, y + 3, w - 2, h - 5, '#a38760');
    p(x + 2, y + 4, w - 4, 2, WOOD_LIGHT);
    key(p, x + 3, y + 8, brass);
    if (w >= 13) key(p, x + 9, y + 10, brass, 1);
    p(x + 3, y + 21, w - 6, 2, WOOD_DARK);
    return;
  }
  if (style === 'cuckoo') {
    for (let row = 0; row < 5; row++) p(mid - row - 2, y + row, row * 2 + 5, 1, WOOD_DARK);
    frame(p, x + 2, y + 5, w - 4, h - 7, color);
    p(mid - 1, y + 5, 3, 2, '#4a3a2c');
  } else if (style === 'round') {
    p(x + 3, y, w - 6, 2, color);
    p(x + 1, y + 2, w - 2, 12, INK);
    p(x, y + 4, w, 8, INK);
    p(x + 2, y + 2, w - 4, 12, color);
  } else {
    frame(p, x + 2, y + 1, w - 4, h - 2, color);
    p(x + 1, y + 2, w - 2, 2, brass);
    if (style === 'carriage') {
      p(mid - 3, y - 1, 6, 1, brass);
      p(mid - 3, y, 1, 2, brass);
      p(mid + 2, y, 1, 2, brass);
      p(x + 1, y + h - 2, w - 2, 2, brass);
    }
  }
  const faceY = y + (style === 'cuckoo' ? 9 : 5);
  p(mid - 4, faceY - 1, 9, 9, PAPER);
  p(mid - 5, faceY + 1, 11, 5, PAPER);
  p(mid, faceY, 1, 1, '#b2996d');
  p(mid - 4, faceY + 3, 1, 1, '#b2996d');
  p(mid + 4, faceY + 3, 1, 1, '#b2996d');
  p(mid, faceY + 6, 1, 1, '#b2996d');
  p(mid, faceY + 1, 1, 4, WOOD_DARK);
  p(mid + (clock.hands % 2 ? -3 : 0), faceY + 3, 4, 1, WOOD_DARK);
  if (style !== 'round') {
    const swing = Math.round(Math.sin(time / 650 + clock.phase) * 2);
    p(mid, faceY + 9, 1, 3, brass);
    p(mid + swing, faceY + 12, 1, 3, brass);
    p(mid - 2 + swing, faceY + 14, 5, 2, brass);
    if (style === 'cuckoo') {
      p(mid - 4, y + h - 1, 1, 3, WOOD_DARK);
      p(mid + 4, y + h - 1, 1, 3, WOOD_DARK);
    }
  }
}

function key(p, x, y, color, variant = 0) {
  frame(p, x, y, 4, 4, '#8a734d', color);
  p(x + 1, y + 3, 1, 6 + variant, color);
  p(x + 1, y + 7 + variant, 3, 1, color);
  p(x + 3, y + 6 + variant, 1, 2, color);
}

function gear(p, x, y, color) {
  p(x + 2, y, 3, 7, color);
  p(x, y + 2, 7, 3, color);
  p(x + 1, y + 1, 5, 5, color);
  p(x + 3, y + 3, 1, 1, '#68583d');
}

function drawWallAccents(p, room, time) {
  if (room.theme === 'memory') {
    p(14, 13, 212, 2, WOOD_DARK);
    p(14, 44, 212, 3, WOOD_DARK);
    p(14, 44, 212, 1, WOOD_LIGHT);
  } else if (room.theme === 'app') {
    // A low cable rail links the decorative device racks, not project data.
    p(17, 44, 205, 1, '#6e8584');
    p(17, 46, 205, 1, '#a8bbb0');
  }
  for (const panel of room.decor?.wallPanels || []) {
    const { x, y, w, h } = panel;
    if (panel.kind === 'bookcase') {
      frame(p, x, y, w, h, '#78603f', WOOD_DARK);
      p(x + 1, y + 1, w - 2, h - 2, '#90734b');
      drawBooks(p, x, y, panel.books);
      p(x, y + 13, w, 2, WOOD_DARK);
      p(x, y + 13, w, 1, WOOD_LIGHT);
      p(x, y + h - 2, w, 2, WOOD_DARK);
      p(x, y + h - 2, w, 1, WOOD_LIGHT);
    } else if (panel.kind === 'clock-collection') {
      for (const clock of panel.clocks) decorativeClock(p, x + clock.x, y + clock.y, clock, time, room.decor.brass);
    } else if (panel.kind === 'device-rack') {
      frame(p, x, y + 1, w, h - 1, '#79918e', '#526a65');
      p(x + 1, y + 2, w - 2, h - 3, '#c3cbb5');
      for (let row = 5; row < h - 3; row += 4) for (let col = 3; col < w - 2; col += 4) p(x + col, y + row, 1, 1, '#97a593');
      let start = 3;
      if (w >= 29) {
        frame(p, x + 3, y + 4, 17, 13, '#567585');
        p(x + 5, y + 6, 13, 8, '#9abfc2');
        p(x + 6, y + 7, 5, 5, PAPER);
        p(x + 13, y + 8, 3, 1, '#d8e1c9');
        p(x + 13, y + 10, 3, 2, '#749a9a');
        p(x + 9, y + 17, 4, 3, '#526a65');
        start = 23;
      }
      for (let dx = start; dx + 6 < w - 1; dx += 10) {
        phone(p, x + dx, y + 5 + (dx % 3), panel.color);
        p(x + dx + 3, y + 17, 1, 6, '#647d78');
        p(x + dx + 3, y + 22, Math.min(6, w - dx - 4), 1, '#647d78');
      }
      p(x + 2, y + h - 2, w - 4, 2, '#76918b');
      p(x + w - 3, y + h, 1, 3, '#6e8584');
    }
  }
}

function drawRoom(ctx, room) {
  const p = painter(ctx);
  const c = room.palette;
  p(0, 0, room.width, room.height, '#263932');
  p(6, 10, 229, 154, '#1d2b27');
  p(9, 7, 222, 157, INK);
  p(12, 10, 216, 151, c.wall);
  // Wallpaper seams and a quiet repeating stitched motif.
  for (let x = 20; x < 223; x += 16) {
    p(x, 13, 1, 30, c.wallShade);
    for (let y = 17; y < 40; y += 13) {
      p(x + 7, y, 1, 3, c.wallShade);
      p(x + 6, y + 1, 3, 1, c.wallShade);
    }
  }
  p(12, 43, 216, 8, c.wallShade);
  p(12, 45, 216, 2, WOOD);
  p(12, 49, 216, 3, WOOD_DARK);
  p(14, 52, 212, 108, c.floor);
  // Staggered individual boards make the cutaway read like a warm wooden floor.
  for (let row = 0; row < 10; row++) {
    const y = 52 + row * 11;
    p(14, y, 212, 1, c.grain);
    p(14, y + 1, 212, 1, c.board);
    for (let x = 14 + ((row % 2) ? 26 : 0); x < 226; x += 49) {
      p(x, y + 2, 1, 9, c.grain);
      p(x + 3, y + 4, 1, 1, c.grain);
    }
  }
  for (const mark of room.floorMarks) p(mark.x, mark.y, mark.w, 1, c.grain);
  // Window, little curtains, and a stepped shaft of afternoon light.
  const win = room.window;
  for (let i = 0; i < 5; i++) p(win.x + 3 + i * 3, 53 + i * 7, 23, 7, '#ffeaba18');
  frame(p, win.x - 2, win.y - 2, win.w + 4, win.h + 5, WOOD);
  p(win.x, win.y, win.w, win.h, '#9dbfc2');
  p(win.x + 1, win.y + 13, win.w - 2, 10, '#87a67b');
  p(win.x + 7, win.y + 10, 8, 6, '#779467');
  p(win.x + 14, win.y + 4, 4, 4, '#f6dea0');
  p(win.x + 10, win.y, 2, win.h, WOOD_DARK);
  p(win.x, win.y + 11, win.w, 2, WOOD_DARK);
  p(win.x - 1, win.y, 4, 17, c.accent);
  p(win.x + 20, win.y, 4, 17, c.accent);
  p(win.x, win.y + 2, 1, 14, '#ffffff44');
  p(win.x + 21, win.y + 2, 1, 14, '#ffffff44');
  p(win.x - 3, win.y + win.h + 2, win.w + 6, 2, WOOD_LIGHT);
  // Thick cutaway beams and the low, interrupted front wall.
  for (const x of [10, 226]) {
    p(x, 9, 4, 153, WOOD_DARK);
    p(x + 1, 10, 1, 149, WOOD_LIGHT);
    p(x + 2, 28, 1, 2, INK);
    p(x + 2, 103, 1, 2, INK);
  }
  p(10, 8, 220, 5, WOOD_DARK);
  p(12, 9, 216, 1, WOOD_LIGHT);
  p(10, 160, room.door.x - 23, 5, WOOD_DARK);
  p(room.door.x + 13, 160, 217 - room.door.x, 5, WOOD_DARK);
  p(11, 160, room.door.x - 24, 1, WOOD_LIGHT);
  p(room.door.x + 13, 160, 216 - room.door.x, 1, WOOD_LIGHT);
}

function drawRug(p, room) {
  const { x, y, w, h, pattern } = room.rug;
  const c = room.palette;
  p(x - 1, y + 2, w + 2, h, '#614b3b33');
  p(x, y, w, h, c.rugDark);
  p(x + 2, y + 2, w - 4, h - 4, c.trim);
  p(x + 4, y + 4, w - 8, h - 8, c.rug);
  p(x + 6, y + 6, w - 12, 1, c.rugDark);
  p(x + 6, y + h - 7, w - 12, 1, c.rugDark);
  for (let j = 3; j < w - 3; j += 3) {
    p(x + j, y - 2, 1, 2, c.trim);
    p(x + j, y + h, 1, 2, c.trim);
  }
  if (pattern === 0) {
    for (let j = -6; j <= 6; j++) {
      const half = 7 - Math.abs(j);
      p(x + w / 2 - half, y + h / 2 + j, half * 2, 1, c.trim);
    }
    p(x + w / 2 - 2, y + h / 2 - 2, 4, 4, c.rugDark);
  } else if (pattern === 1) {
    for (let j = 11; j < h - 9; j += 8) p(x + 8, y + j, w - 16, 2, c.rugDark);
  } else {
    for (let row = 11; row < h - 9; row += 10) for (let col = 12; col < w - 9; col += 11) {
      p(x + col, y + row, 1, 3, c.trim);
      p(x + col - 1, y + row + 1, 3, 1, c.trim);
    }
  }
}

function desk(p, object, color) {
  const { x, y, w, h } = object;
  p(x + 2, y + h - 2, w, 4, '#61483144');
  p(x + 3, y + h - 10, 4, 10, WOOD_DARK);
  p(x + w - 7, y + h - 10, 4, 10, WOOD_DARK);
  frame(p, x, y + h - 18, w, 11, WOOD);
  p(x + 1, y + h - 17, w - 2, 3, WOOD_LIGHT);
  p(x + 3, y + h - 12, w - 6, 2, color);
  p(x + 5, y + h - 10, 2, 1, '#e6bf73');
}

function mug(p, x, y, color, time) {
  p(x, y, 5, 5, color);
  p(x + 1, y, 3, 1, '#6d4b36');
  p(x + 5, y + 1, 2, 3, color);
  p(x + 5, y + 2, 1, 1, WOOD);
  if (time !== null) {
    const sway = Math.floor(time / 750) % 2;
    p(x + 2 + sway, y - 5, 1, 2, '#fff3d299');
    p(x + 2, y - 2, 1, 1, '#fff3d2bb');
  }
}

function request(ctx, object) {
  const p = painter(ctx);
  const { x, y, w, h } = object;
  p(x + 1, y + 2, w, h, '#69513b44');
  frame(p, x, y, w, h, WOOD_LIGHT);
  p(x + 2, y + 2, w - 4, h - 4, '#d2b17b');
  p(x + 6, y + 3, w - 12, h - 6, PAPER);
  p(x + 7, y + 4, w - 14, 1, '#ffffff');
  p(x + w / 2, y + 3, 2, 2, '#be6252');
  smallText(ctx, 'ASK', x + 10, y + 8, '#7a6650');
  for (let row = 0; row < 3; row++) p(x + 9, y + 14 + row * 3, w - 19 - row * 2, 1, '#baad8b');
  p(x + w - 6, y + h - 7, 3, 3, '#e7d8b7');
}

function clock(ctx, object, agent) {
  const p = painter(ctx);
  const { x, y, w, h } = object;
  frame(p, x + 3, y + 8, w - 6, h - 8, WOOD);
  p(x + 7, y + 17, 1, 4, '#deb869');
  p(x + 6, y + 21, 3, 2, '#deb869');
  p(x + 3, y, w - 6, 2, INK);
  p(x + 1, y + 2, w - 2, 12, INK);
  p(x, y + 4, w, 8, INK);
  p(x + 3, y + 2, w - 6, 12, PAPER);
  p(x + 2, y + 4, w - 4, 8, PAPER);
  if (agent?.taskStartedAt != null || agent?.sessionStartedAt != null || agent?.startedAt != null) {
    p(x + 7, y + 4, 1, 5, WOOD_DARK);
    p(x + 7, y + 8, 4, 1, WOOD_DARK);
  } else {
    smallText(ctx, '?', x + 6, y + 5, WOOD_DARK, 6);
  }
  p(x + 7, y + 2, 1, 1, '#ba9c62');
  p(x + 7, y + 13, 1, 1, '#ba9c62');
}

function workbench(ctx, object, room, time, agent) {
  const p = painter(ctx);
  const { x, y, w } = object;
  desk(p, object, room.palette.accent);
  if (room.theme === 'app') {
    // A desktop, a second little screen, and the inevitable charging cable.
    for (const [dx, dy, sw] of [[4, 0, 24], [31, 2, 18]]) {
      frame(p, x + dx, y + dy, sw, 14, '#557582');
      p(x + dx + 2, y + dy + 2, sw - 4, 9, '#345966');
      p(x + dx + 3, y + dy + 3, 5, 6, room.decor.deviceColor);
      p(x + dx + 10, y + dy + 4, sw - 13, 2, '#aaccca');
      p(x + dx + 10, y + dy + 8, sw - 13, 1, '#709ca0');
      p(x + dx + Math.floor(sw / 2), y + dy + 14, 2, 2, '#52676c');
    }
    p(x + 6, y + 17, 19, 3, '#bdc7b7');
    for (let dx = 7; dx < 23; dx += 3) p(x + dx, y + 18, 1, 1, '#78928e');
    phone(p, x + 30, y + 15, room.decor.deviceColor);
    p(x + 33, y + 26, 1, 3, '#536b65');
    p(x + 33, y + 28, 15, 1, '#536b65');
    mug(p, x + w - 10, y + 17, '#d9cab0', time);
    return;
  }
  if (room.theme === 'memory') {
    bookPile(p, x + 3, y + 12, room, 4, 14);
    openBook(p, x + 20, y + 7, 23, 12);
    // A green reading lamp leaves a pool of light across the manuscript.
    p(x + 39, y + 9, 9, 10, '#eddb8e22');
    p(x + w - 9, y + 4, 1, 13, '#b29b5b');
    p(x + w - 13, y + 17, 9, 1, WOOD_DARK);
    p(x + w - 15, y + 2, 13, 3, '#658876');
    p(x + w - 13, y, 9, 2, '#88a58b');
    p(x + 17, y + 11, 1, 8, '#b78959');
    p(x + 17, y + 18, 1, 2, INK);
    mug(p, x + 5, y + 17, '#dcd0b6', time);
    return;
  }
  if (room.theme === 'vault') {
    // The diagnostic journal lives at an actual clock-repair bench here.
    p(x + 3, y + 7, w - 6, 13, '#718375');
    decorativeClock(p, x + 5, y - 3, { w: 16, h: 17, style: 'round', color: room.decor.brass, hands: room.decor.surfaceVariant }, 0, room.decor.brass);
    gear(p, x + 25, y + 7, room.decor.brass);
    gear(p, x + 35, y + 10, '#d6bc85');
    p(x + 25, y + 18, 14, 1, '#b9c2b2');
    p(x + 24, y + 17, 3, 3, '#927054');
    frame(p, x + w - 9, y + 1, 6, 6, '#b6d0c4', '#687f72');
    p(x + w - 8, y + 7, 2, 8, WOOD_DARK);
    p(x + w - 14, y + 8, 1, 8, '#cdd0b5');
    p(x + w - 15, y + 13, 3, 5, '#af755a');
    mug(p, x + 6, y + 17, '#d4b284', time);
    return;
  }
  frame(p, x + 7, y, 25, 15, '#5f6f67');
  p(x + 9, y + 2, 21, 10, '#2e4540');
  p(x + 11, y + 4, 9, 1, '#9ab69b');
  p(x + 11, y + 7, 14, 1, '#648b7c');
  if (agent?.status === 'working' && Math.floor(time / 550) % 2 === 0) p(x + 11, y + 10, 3, 1, '#dfcc90');
  p(x + 17, y + 15, 5, 2, WOOD_DARK);
  p(x + 11, y + 17, 18, 2, '#c1bda5');
  p(x + w - 16, y + 11, 7, 3, PAPER);
  mug(p, x + w - 10, y + 12, '#e1d0b3', time);
  p(x + 2, y + 18, 4, 1, '#a04f47');
}

function parcel(p, x, y, stage, time) {
  const colors = { ready: '#edce6f', merged: '#8dad7c', blocked: '#bd6c58', closed: '#8b8077', unknown: '#969995' };
  if (stage === 'none') {
    p(x, y + 7, 18, 2, WOOD_DARK);
    p(x, y + 4, 2, 4, WOOD);
    p(x + 16, y + 4, 2, 4, WOOD);
    return;
  }
  const color = colors[stage] || '#d7ac64';
  frame(p, x, y, 18, 11, color);
  p(x + 1, y + 1, 16, 2, '#ffffff33');
  p(x + 8, y + 1, 2, 9, stage === 'ready' ? '#fff0ad' : '#9a7b50');
  p(x + 1, y + 5, 16, 1, '#9a7b50');
  if (stage === 'ready') {
    p(x + 5, y - 2, 3, 2, '#f8dd86');
    p(x + 10, y - 2, 3, 2, '#f8dd86');
    p(x + 8, y - 1, 2, 3, '#fff0ad');
  } else if (stage === 'merged') {
    p(x + 2, y - 3, 6, 4, '#c6d3ad');
    p(x + 10, y - 3, 6, 4, '#c6d3ad');
    p(x + 2, y + 3, 14, 3, '#6f8b60');
  } else if (stage === 'blocked') {
    p(x + 13, y - 5, 2, 3, '#d9614f');
    p(x + 13, y - 1, 2, 1, '#d9614f');
  } else if (stage === 'active') {
    const bob = Math.floor(time / 350) % 2;
    p(x + 12 + bob, y - 4, 2, 6, '#a2b3b0');
    p(x + 10 + bob, y - 5, 6, 2, '#596a68');
  } else if (stage === 'waiting-codex') {
    frame(p, x + 10, y - 5, 7, 6, '#c7dbd7', '#617d79');
    p(x + 16, y, 2, 3, '#617d79');
  } else if (stage === 'waiting-ci') {
    p(x + 12, y - 6, 5, 1, INK);
    p(x + 13, y - 5, 3, 4, '#dfd1ac');
    p(x + 14, y - 4, 1, 2, '#b88c56');
    p(x + 12, y - 1, 5, 1, INK);
  } else if (stage === 'unknown') {
    p(x + 13, y + 2, 2, 2, PAPER);
    p(x + 12, y + 4, 2, 2, PAPER);
    p(x + 12, y + 7, 1, 1, PAPER);
  } else if (stage === 'closed') {
    p(x + 2, y + 2, 3, 1, '#695b53');
    p(x + 3, y + 3, 1, 3, '#695b53');
  }
}

function review(ctx, object, room, time, stage) {
  const p = painter(ctx);
  const { x, y, w } = object;
  desk(p, object, room.palette.rugDark);
  p(x + 6, y + 1, 16, 15, '#e2d4b7');
  p(x + 5, y, 16, 14, PAPER);
  for (let row = 0; row < 4; row++) p(x + 8, y + 3 + row * 2, 9 - (row % 2) * 2, 1, '#c4b494');
  p(x + 24, y + 10, 2, 7, '#897698');
  p(x + 24, y + 9, 2, 2, '#f0dcad');
  if (room.theme === 'app') {
    frame(p, x + 4, y - 1, 17, 16, '#557680');
    p(x + 6, y + 1, 13, 11, '#a1c5c6');
    p(x + 8, y + 3, 8, 2, PAPER);
    p(x + 8, y + 7, 6, 1, '#587f88');
    p(x + 8, y + 10, 9, 1, '#587f88');
    p(x + 12, y + 13, 2, 1, '#d0d5b9');
  } else if (room.theme === 'memory') {
    bookPile(p, x + 2, y + 13, room, 2, 19);
    openBook(p, x + 3, y + 2, 20, 10);
  } else if (room.theme === 'vault') {
    p(x + 2, y + 14, 23, 5, '#9b7f58');
    key(p, x + 7, y + 2, room.decor.brass);
    gear(p, x + 16, y + 5, room.decor.brass);
    p(x + 3, y + 18, 18, 1, '#dfc694');
  }
  parcel(p, x + w - 22, y + 2, stage, time);
}

function shelf(ctx, object, room, agent, stage) {
  const p = painter(ctx);
  const { x, y, w, h } = object;
  frame(p, x, y, w, h, WOOD_DARK);
  p(x + 2, y + 1, w - 4, h - 2, '#946840');
  p(x + 1, y + 1, w - 2, 2, WOOD_LIGHT);
  p(x + 2, y + h - 4, w - 4, 2, WOOD_LIGHT);
  for (let i = 0; i < 5; i++) {
    const height = 8 + i % 3 * 2;
    p(x + 4 + i * 4, y + h - 4 - height, 3, height, room.bookColors[i]);
    p(x + 4 + i * 4, y + h - 4 - height + 2, 2, 1, '#eee3bf88');
  }
  if (room.theme === 'app') {
    p(x + 3, y + 4, 23, h - 8, '#66807a');
    phone(p, x + 4, y + 4, room.decor.deviceColor);
    phone(p, x + 12, y + 4, '#aac1a9');
    phone(p, x + 20, y + 4, '#b8aabe');
    p(x + 3, y + h - 3, 24, 1, '#d4ddc2');
    p(x + 8, y + h, 1, 3, '#576c63');
    p(x + 8, y + h + 2, 17, 1, '#576c63');
  } else if (room.theme === 'memory') {
    bookPile(p, x + 3, y - 1, room, 3, 20);
    p(x + 19, y + 3, 2, h - 8, '#a6b5a0');
    p(x + 23, y + 5, 2, h - 10, '#c8ad75');
  } else if (room.theme === 'vault') {
    p(x + 3, y + 4, 24, h - 8, '#796143');
    decorativeClock(p, x + 3, y + 1, { w: 12, h: 17, style: 'round', color: room.decor.brass, hands: 1 }, 0, room.decor.brass);
    decorativeClock(p, x + 15, y + 3, { w: 12, h: 17, style: 'round', color: '#b68f69', hands: 0 }, 0, room.decor.brass);
  }
  const hasArtifacts = (Array.isArray(agent?.artifacts) && agent.artifacts.length > 0) || Boolean(agent?.result);
  if (stage === 'merged') {
    frame(p, x + w - 13, y + 5, 9, 11, '#99b58a');
    p(x + w - 11, y + 8, 5, 1, PAPER);
    p(x + w - 11, y + 11, 4, 1, PAPER);
  } else if (hasArtifacts) {
    p(x + w - 14, y + h - 10, 10, 5, PAPER);
    p(x + w - 13, y + h - 12, 8, 2, '#c4b79b');
    p(x + w - 10, y + h - 11, 1, 6, '#a97562');
  } else {
    p(x + w - 10, y + h - 8, 4, 4, '#c29d6e');
    p(x + w - 9, y + h - 11, 2, 3, '#7e9970');
  }
}

function themeFurniture(ctx, object, room) {
  const p = painter(ctx);
  const { x, y, w, h } = object;
  p(x + 1, y + h - 1, w, 3, '#61483144');
  frame(p, x, y, w, h, WOOD);
  p(x + 1, y + 1, w - 2, 2, WOOD_LIGHT);
  if (room.theme === 'hub') {
    frame(p, x + 3, y + 4, 12, h - 7, '#68857a');
    for (let col = 0; col < 2; col++) for (let row = 0; row < 3; row++) p(x + 5 + col * 5, y + 6 + row * 3, 2, 1, '#dac982');
    p(x + 8, y + 14, 1, 5, '#384d47');
    p(x + 8, y + 18, 10, 1, '#384d47');
    for (let row = 0; row < 3; row++) {
      p(x + 18, y + 5 + row * 4, w - 21, 3, WOOD_DARK);
      p(x + 19, y + 6 + row * 4, w - 25, 1, PAPER);
    }
  } else if (room.theme === 'app') {
    p(x + 2, y + 3, w - 4, h - 5, '#77908a');
    for (let i = 0; i < 3; i++) {
      phone(p, x + 4 + i * 9, y + 4 - i % 2, [room.decor.deviceColor, '#a7bea9', '#b4a8bd'][i]);
      p(x + 7 + i * 9, y + 15, 1, 3, '#d7d6b8');
    }
    p(x + 3, y + h - 3, w - 6, 1, '#c2c4a5');
    p(x + w - 5, y + h, 1, 5, '#536c64');
    p(x + 9, y + h + 4, w - 13, 1, '#536c64');
    p(x + 9, y + h + 2, 1, 3, '#536c64');
  } else if (room.theme === 'memory') {
    for (let col = 0; col < 3; col++) for (let row = 0; row < 2; row++) {
      frame(p, x + 3 + col * 9, y + 5 + row * 6, 8, 5, '#ac8759', WOOD_DARK);
      p(x + 5 + col * 9, y + 7 + row * 6, 3, 1, '#e2c781');
    }
    bookPile(p, x + 3, y - 1, room, 3, 17);
    bookPile(p, x + 21, y, room, 2, 9);
    p(x + w - 3, y + 3, 1, h - 4, '#c8a67a');
  } else if (room.theme === 'vault') {
    for (let i = 0; i < 2; i++) frame(p, x + 3 + i * 13, y + 4, 12, h - 6, WOOD_LIGHT, WOOD_DARK);
    p(x + 13, y + 12, 2, 2, '#e7c26a');
    p(x + 17, y + 12, 2, 2, '#e7c26a');
    key(p, x + 5, y + 4, room.decor.brass);
    frame(p, x + 20, y + 5, 6, 5, '#b09667', room.decor.brass);
    p(x + 21, y + 3, 4, 1, room.decor.brass);
    p(x + 21, y + 4, 1, 2, room.decor.brass);
    p(x + 24, y + 4, 1, 2, room.decor.brass);
    p(x + 22, y + 7, 1, 2, INK);
    gear(p, x + 5, y - 5, room.decor.brass);
    p(x + 17, y - 3, 11, 1, '#c2c9b4');
    p(x + 16, y - 4, 3, 3, '#8d6250');
  } else {
    p(x + 3, y + 5, w - 6, 5, WOOD_DARK);
    p(x + 5, y + 6, 10, 3, room.bookColors[6]);
    p(x + 18, y + 6, 8, 3, PAPER);
    p(x + 3, y + 12, w - 6, 5, WOOD_LIGHT);
    p(x + w / 2 - 2, y + 14, 4, 1, WOOD_DARK);
    p(x + 5, y - 3, 8, 3, room.palette.accent);
  }
}

function hearth(p, object, time, room) {
  const { x, y, w, h } = object;
  p(x - 4, y + h - 3, w + 8, 3, '#e5c07718');
  frame(p, x + 2, y, w - 4, h, '#9b9080');
  for (let row = 0; row < 4; row++) {
    p(x + 3, y + 5 + row * 5, w - 6, 1, '#7a7166');
    for (let col = 0; col < 3; col++) p(x + 5 + col * 9 + row % 2 * 3, y + 2 + row * 5, 1, 3, '#7a7166');
  }
  frame(p, x + 7, y + 9, w - 14, h - 12, '#4b3b30');
  p(x + 8, y + h - 7, w - 16, 3, '#8d4c35');
  const flicker = Math.floor(time / 250) % 2;
  p(x + 11, y + h - 12 - flicker, 4, 7 + flicker, '#d98646');
  p(x + 16, y + h - 10 + flicker, 4, 5 - flicker, '#e5a44e');
  p(x + 13, y + h - 9, 3, 4, '#f7ce77');
  p(x, y + 2, w, 3, WOOD_DARK);
  p(x + 1, y + 2, w - 2, 1, WOOD_LIGHT);
  p(x + 3, y + h - 2, w - 6, 2, '#bab19e');
  p(x + 5, y - 2, 4, 4, '#b29b79');
  p(x + 6, y - 4, 2, 2, '#758766');
  p(x + w - 9, y - 1, 3, 3, '#ecdbb3');
  if (room.theme === 'memory') {
    bookPile(p, x + w - 16, y, room, 3, 12);
    p(x + 4, y + h + 1, 6, 1, '#c7ae78');
  } else if (room.theme === 'app') {
    phone(p, x + w - 13, y - 8, room.decor.deviceColor, true);
    p(x + w - 9, y + 5, 1, 4, '#657969');
    p(x + 4, y - 3, 7, 4, '#9cae9a');
    p(x + 5, y - 5, 1, 2, '#647d76');
    p(x + 9, y - 5, 1, 2, '#647d76');
  } else if (room.theme === 'vault') {
    frame(p, x + w - 16, y - 10, 12, 12, '#ab8b58');
    p(x + w - 14, y - 8, 8, 7, PAPER);
    p(x + w - 11, y - 7, 1, 4, WOOD_DARK);
    p(x + w - 11, y - 4, 3, 1, WOOD_DARK);
    p(x + w - 18, y + 1, 16, 2, WOOD_DARK);
  }
}

function chair(p, object, room) {
  const { x, y, w, h } = object;
  p(x + 2, y + h - 1, w, 3, '#61483144');
  frame(p, x + 2, y, w - 4, h - 3, room.palette.rugDark);
  p(x + 4, y + 2, w - 8, 8, room.palette.rug);
  p(x + 1, y + 8, 4, h - 9, room.palette.rugDark);
  p(x + w - 5, y + 8, 4, h - 9, room.palette.rugDark);
  p(x + 5, y + 11, w - 10, 5, room.palette.rug);
  p(x + 3, y + h - 3, 2, 3, WOOD_DARK);
  p(x + w - 5, y + h - 3, 2, 3, WOOD_DARK);
  p(x + w - 9, y + 6, 4, 9, room.palette.trim);
  p(x + w - 8, y + 7, 1, 8, room.palette.accent);
  if (room.theme === 'memory') openBook(p, x + 4, y + 9, 12, 7);
  if (room.theme === 'app') phone(p, x + 5, y + 5, room.decor.deviceColor);
  if (room.theme === 'vault') {
    key(p, x + 6, y + 6, room.decor.brass);
    p(x + 5, y + 8, 5, 1, room.palette.rugDark);
  }
}

function plant(p, object) {
  const { x, y, w, h, variant } = object;
  p(x + 2, y + h - 1, w - 2, 2, '#61483144');
  frame(p, x + 2, y + h - 7, w - 4, 6, '#b9815b');
  p(x + 1, y + h - 8, w - 2, 2, '#d09b6b');
  p(x + 5, y + 4, 2, h - 10, '#54754d');
  p(x + 2, y + 3 + variant, 4, 6, '#74905e');
  p(x + 6, y + 1, 4, 7, '#819e6c');
  p(x, y + 8, 5, 4, '#537950');
  p(x + 7, y + 8 - variant, 5, 5, '#678e5d');
  p(x + 7, y + 2, 1, 3, '#a3b37d');
}

function drawExit(p, room) {
  const x = room.door.x;
  p(x - 13, 154, 26, 11, WOOD_DARK);
  p(x - 12, 155, 24, 9, '#d0ad7e');
  p(x - 10, 156, 20, 6, '#81918a');
  p(x - 8, 158, 16, 1, '#bec4a8');
  p(x - 15, 164, 30, 3, '#9f9b85');
  p(x - 15, 167, 30, 2, '#6c776d');
  for (const side of [-15, 12]) {
    p(x + side, 150, 3, 14, WOOD_DARK);
    p(x + side + 1, 150, 1, 12, WOOD_LIGHT);
  }
}

/** Draw a 12×18 resident about a foot-center point. Animation time is milliseconds. */
export function renderResident(ctx, x, y, resident = {}, { time = 0, walking = false, scale = 1 } = {}) {
  const skin = resident.skin || SKINS[0];
  const hair = resident.hair || HAIR[0];
  const clothing = resident.clothing || CLOTHES[0];
  const trousers = resident.trousers || '#4c5963';
  const accent = resident.accent || '#dcc795';
  const step = walking ? Math.floor(time / 150) % 2 : 0;
  ctx.save();
  ctx.translate(Math.round(x), Math.round(y));
  ctx.scale(scale, scale);
  const p = painter(ctx);
  p(-4, -1, 9, 2, '#513f3438');
  const draw = (xx, yy, w, h, color) => p(xx, yy - step, w, h, color);
  if (resident.hairStyle === 2) draw(-5, -14, 10, 10, hair);
  draw(-4, -9, 8, 7, INK);
  draw(-3, -8, 6, 5, clothing);
  draw(-5, -7, 2, 4, clothing);
  draw(3, -7, 2, 4, clothing);
  draw(-5, -3, 2, 2, skin);
  draw(3, -3, 2, 2, skin);
  if (resident.outfit === 1) {
    draw(-2, -8, 1, 5, accent);
    draw(1, -8, 1, 5, accent);
    draw(-2, -5, 4, 2, accent);
  } else if (resident.outfit === 2) {
    draw(0, -8, 1, 5, accent);
    draw(-2, -5, 1, 1, '#e8d7ae');
  } else if (resident.outfit === 3) {
    draw(-3, -6, 6, 1, accent);
  }
  p(-3 - step, -3, 2, 3, trousers);
  p(1 + step, -3, 2, 3, trousers);
  p(-4 - step, 0, 3, 1, INK);
  p(1 + step, 0, 3, 1, INK);
  draw(-4, -15, 8, 7, INK);
  draw(-3, -14, 6, 5, skin);
  draw(-4, -16, 7, 3, hair);
  draw(-4, -14, 2, 3, hair);
  draw(3, -14, 1, 3, hair);
  if (resident.hairStyle === 1) {
    draw(1, -14, 2, 2, hair);
    draw(-5, -14, 1, 4, hair);
  } else if (resident.hairStyle === 3) {
    draw(1, -17, 3, 2, hair);
    draw(3, -15, 2, 4, hair);
  }
  draw(-1, -11, 1, 1, INK);
  draw(2, -11, 1, 1, INK);
  draw(0, -9, 2, 1, '#a56a51');
  if (resident.accessory === 'glasses') {
    draw(-2, -12, 3, 1, INK);
    draw(1, -12, 3, 1, INK);
    draw(-2, -11, 1, 2, INK);
    draw(3, -11, 1, 2, INK);
  } else if (resident.accessory === 'scarf') {
    draw(-3, -8, 6, 1, accent);
    draw(1, -7, 2, 3, accent);
  }
  if (resident.headgear === 'beanie') {
    draw(-4, -16, 8, 3, clothing);
    draw(-2, -18, 4, 2, clothing);
    draw(-4, -14, 8, 1, accent);
  } else if (resident.headgear === 'cap') {
    draw(-4, -16, 8, 2, clothing);
    draw(-2, -17, 5, 1, clothing);
    draw(-4, -14, 10, 1, clothing);
  } else if (resident.headgear === 'headphones') {
    draw(-5, -15, 10, 1, '#c6b992');
    draw(-5, -14, 2, 4, '#607981');
    draw(4, -14, 2, 4, '#607981');
  } else if (resident.headgear === 'flower') {
    draw(-5, -15, 3, 3, '#d0a0a0');
    draw(-4, -14, 1, 1, '#f4d381');
  }
  // Personal props are seeded decoration; they never stand in for task status.
  if (resident.heldItem === 'phone') {
    draw(1, -8, 4, 7, '#31434b');
    draw(2, -7, 2, 4, '#9dcad0');
    draw(2, -6, 1, 1, '#e5e7c5');
    draw(0, -4, 2, 2, skin);
    draw(4, -5, 1, 3, skin);
  } else if (resident.heldItem === 'tablet') {
    draw(-3, -7, 8, 6, '#354650');
    draw(-2, -6, 6, 4, '#94bbc6');
    draw(-4, -4, 2, 2, skin);
    draw(4, -4, 2, 2, skin);
    draw(0, -5, 1, 1, '#dfe7cb');
  } else if (resident.heldItem === 'book') {
    draw(-4, -7, 9, 6, '#886d48');
    draw(-3, -7, 7, 5, PAPER);
    draw(0, -6, 1, 4, '#bbad88');
    draw(-4, -3, 2, 2, skin);
    draw(4, -4, 1, 2, skin);
  } else if (resident.heldItem === 'keyring') {
    draw(4, -7, 3, 3, '#dcb97a');
    draw(5, -6, 1, 1, INK);
    draw(5, -4, 1, 5, '#dcb97a');
    draw(5, -1, 3, 1, '#dcb97a');
    draw(3, -5, 2, 2, skin);
  } else if (resident.heldItem === 'loupe') {
    draw(2, -12, 4, 4, '#ae9f71');
    draw(3, -11, 2, 2, '#acc7b9');
    draw(4, -8, 1, 4, '#6f6655');
    draw(3, -5, 2, 2, skin);
  } else if (resident.heldItem === 'tool') {
    draw(5, -9, 1, 7, '#d8c8a3');
    draw(4, -10, 3, 2, '#acbcae');
    draw(4, -4, 2, 3, '#a87a56');
    draw(3, -5, 2, 2, skin);
  }
  ctx.restore();
}

/** Render into a 240×176 coordinate space; the caller owns camera/scaling. */
export function renderInterior(ctx, room, { time = 0, agent = {}, player = null, selectedObject = null, reduce = false } = {}) {
  const frameTime = reduce ? 0 : time;
  ctx.save();
  ctx.imageSmoothingEnabled = false;
  drawRoom(ctx, room);
  const p = painter(ctx);
  drawWallAccents(p, room, frameTime);
  drawRug(p, room);
  drawExit(p, room);
  const stage = prStage(agent.pr);
  const layers = room.objects.filter((object) => object.id !== 'exit').map((object) => ({ y: object.y + object.h, object }));
  layers.push({ y: room.resident.y, resident: room.resident });
  if (player) layers.push({ y: player.y, player });
  layers.sort((a, b) => a.y - b.y);
  for (const layer of layers) {
    if (layer.resident) {
      renderResident(ctx, room.resident.x, room.resident.y, room.resident, { time: frameTime });
    } else if (layer.player) {
      renderResident(ctx, player.x, player.y, {
        skin: SKINS[0], hair: HAIR[0], clothing: '#345670', trousers: '#46505c', headgear: 'cap', accent: '#ce6554',
        ...player.resident,
      }, { time: frameTime, walking: !reduce && player.walking });
      // Jack's familiar red cap is a navigation cue, independent of generated residents.
      if (!player.resident) {
        const step = !reduce && player.walking ? Math.floor(frameTime / 150) % 2 : 0;
        p(player.x - 4, player.y - 16 - step, 8, 2, '#c45e4d');
        p(player.x - 2, player.y - 17 - step, 5, 1, '#c45e4d');
        p(player.x - 4, player.y - 14 - step, 10, 1, '#c45e4d');
      }
    } else {
      const object = layer.object;
      if (object.id === 'request') request(ctx, object);
      else if (object.id === 'clock') clock(ctx, object, agent);
      else if (object.id === 'workbench') workbench(ctx, object, room, frameTime, agent);
      else if (object.id === 'review') review(ctx, object, room, frameTime, stage);
      else if (object.id === 'shelf') shelf(ctx, object, room, agent, stage);
      else if (object.id === 'theme') themeFurniture(ctx, object, room);
      else if (object.id === 'hearth') hearth(p, object, frameTime, room);
      else if (object.id === 'chair') chair(p, object, room);
      else if (object.id === 'plant') plant(p, object);
    }
  }
  const selectedId = typeof selectedObject === 'object' ? selectedObject?.id : selectedObject;
  const selected = room.objects.find((object) => object.id === selectedId);
  if (selected) {
    const { x, y, w, h } = selected;
    const color = '#fff0b3';
    for (const [xx, yy, sx, sy] of [[x - 2, y - 2, 1, 1], [x + w + 1, y - 2, -1, 1], [x - 2, y + h + 1, 1, -1], [x + w + 1, y + h + 1, -1, -1]]) {
      p(xx + (sx < 0 ? -3 : 0), yy, 4, 1, color);
      p(xx, yy + (sy < 0 ? -3 : 0), 1, 4, color);
    }
    ctx.font = '6px "Silkscreen", monospace';
    const label = selected.label;
    const labelWidth = Math.ceil(ctx.measureText(label).width) + 10;
    const labelX = Math.max(4, Math.min(room.width - labelWidth - 4, Math.round(x + w / 2 - labelWidth / 2)));
    const labelY = y > 24 ? y - 13 : y + h + 5;
    frame(p, labelX, labelY, labelWidth, 11, '#3e4c42', '#e0c993');
    smallText(ctx, label, labelX + 5, labelY + 3, '#fff0cb', 6);
  }
  ctx.restore();
}
