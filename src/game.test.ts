import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Cell, Maze } from './maze';
import { PACMAN_START, countRemaining, createMaze, isWalkable } from './maze';
import { TILE, dotsText, drawFrame, statusText } from './render';
import {
  BOOST_DURATION,
  BOOST_SPEED_MULTIPLIER,
  FRUIT_POS,
  READY_TICKS,
  attemptMove,
  checkWin,
  createGameState,
  eatDot,
  loseLife,
  nextPosition,
  resolveGhostCollisions,
  tick,
  togglePause,
  type GameState,
  type Ghost,
} from './game';

function buildMaze(rows: string[]): Maze {
  const grid: Cell[][] = rows.map((row) =>
    [...row].map((ch): Cell => {
      if (ch === '#') return 'wall';
      if (ch === '.') return 'dot';
      if (ch === 'o') return 'pellet';
      return 'empty';
    }),
  );
  return { width: rows[0]?.length ?? 0, height: rows.length, grid };
}

function buildGhost(overrides: Partial<Ghost> = {}): Ghost {
  return {
    id: 0,
    pos: { x: 1, y: 1 },
    dir: 'up',
    mode: 'chase',
    home: { x: 1, y: 1 },
    ...overrides,
  };
}

function buildState(overrides: Partial<GameState> = {}): GameState {
  const maze = buildMaze(['#####', '#...#', '#...#', '#...#', '#####']);
  return {
    maze,
    pacman: { pos: { x: 2, y: 2 }, dir: 'right' },
    ghosts: [],
    score: 0,
    lives: 3,
    dotsRemaining: 9,
    dotsTotal: 9,
    fruit: { phase: 'waiting', ticksLeft: 0 },
    frightenedTicks: 0,
    boostTicks: 0,
    readyTicks: 0,
    status: 'playing',
    paused: false,
    ...overrides,
  };
}

describe('nextPosition', () => {
  it('P0-GAME-001 moves right by incrementing x', () => {
    expect(nextPosition({ x: 0, y: 0 }, 'right')).toEqual({ x: 1, y: 0 });
  });

  it('P0-GAME-001 moves left by decrementing x', () => {
    expect(nextPosition({ x: 5, y: 5 }, 'left')).toEqual({ x: 4, y: 5 });
  });

  it('P0-GAME-001 moves up by decrementing y', () => {
    expect(nextPosition({ x: 5, y: 5 }, 'up')).toEqual({ x: 5, y: 4 });
  });

  it('P0-GAME-001 moves down by incrementing y', () => {
    expect(nextPosition({ x: 5, y: 5 }, 'down')).toEqual({ x: 5, y: 6 });
  });

  it('does not mutate the input position', () => {
    const pos = { x: 0, y: 0 };
    nextPosition(pos, 'right');
    expect(pos).toEqual({ x: 0, y: 0 });
  });
});

describe('attemptMove', () => {
  it('P0-GAME-002 moves onto an open tile', () => {
    const maze = buildMaze(['###', '#..', '###']);
    expect(attemptMove(maze, { x: 1, y: 1 }, 'right')).toEqual({ x: 2, y: 1 });
  });

  it('P0-GAME-002 is blocked by a wall and keeps the current tile', () => {
    const maze = buildMaze(['###', '#.#', '###']);
    expect(attemptMove(maze, { x: 1, y: 1 }, 'right')).toEqual({ x: 1, y: 1 });
  });

  it('P0-GAME-002 is blocked at the edge of the maze', () => {
    const maze = buildMaze(['###', '#.#', '###']);
    expect(attemptMove(maze, { x: 1, y: 1 }, 'up')).toEqual({ x: 1, y: 1 });
  });
});

describe('eatDot', () => {
  it('P0-GAME-003 eats a dot, scores and clears the tile', () => {
    const state = buildState();
    const next = eatDot(state, { x: 2, y: 2 });
    expect(next.score).toBe(10);
    expect(next.dotsRemaining).toBe(8);
    expect(next.maze.grid[2]?.[2]).toBe('empty');
  });

  it('P0-GAME-003 eats a power pellet, scores more and frightens the ghosts', () => {
    const maze = buildMaze(['#####', '#o..#', '#...#', '#...#', '#####']);
    const state = buildState({ maze, ghosts: [buildGhost()] });
    const next = eatDot(state, { x: 1, y: 1 });
    expect(next.score).toBe(50);
    expect(next.frightenedTicks).toBeGreaterThan(0);
    expect(next.ghosts.every((g) => g.mode === 'frightened')).toBe(true);
  });

  it('P0-GAME-003 leaves an already-eaten tile unchanged', () => {
    const state = buildState();
    const eaten = eatDot(state, { x: 2, y: 2 });
    const again = eatDot(eaten, { x: 2, y: 2 });
    expect(again).toEqual(eaten);
  });
});

describe('resolveGhostCollisions', () => {
  it('P0-GAME-004 costs a life when a chasing ghost catches pacman', () => {
    const state = buildState({ ghosts: [buildGhost({ pos: { x: 2, y: 2 }, mode: 'chase' })] });
    const next = resolveGhostCollisions(state);
    expect(next.lives).toBe(2);
    expect(next.pacman.pos).toEqual(PACMAN_START);
  });

  it('P0-GAME-004 sends a frightened ghost home and awards points without costing a life', () => {
    const ghost = buildGhost({ pos: { x: 2, y: 2 }, mode: 'frightened', home: { x: 3, y: 3 } });
    const state = buildState({ ghosts: [ghost], lives: 3 });
    const next = resolveGhostCollisions(state);
    expect(next.lives).toBe(3);
    expect(next.score).toBe(200);
    expect(next.ghosts[0]?.pos).toEqual({ x: 2, y: 2 });
    expect(next.ghosts[0]?.mode).toBe('returning');
  });

  it('P0-GAME-004 leaves the game unchanged when no ghost overlaps pacman', () => {
    const state = buildState({ ghosts: [buildGhost({ pos: { x: 1, y: 1 } })] });
    expect(resolveGhostCollisions(state)).toEqual(state);
  });

  it('P0-GAME-004 catches pacman moving onto a chasing ghost in the same tick', () => {
    const maze = buildMaze(['#####', '#...#', '#...#', '#...#', '#####']);
    const state = buildState({
      maze,
      pacman: { pos: { x: 2, y: 2 }, dir: 'right' },
      ghosts: [buildGhost({ pos: { x: 3, y: 2 }, mode: 'chase' })],
      lives: 3,
    });
    const next = tick(state, 'right');
    expect(next.lives).toBe(2);
    expect(next.pacman.pos).toEqual(PACMAN_START);
  });

  it('P0-GAME-004 eats a frightened ghost pacman moves onto in the same tick', () => {
    const maze = buildMaze(['#####', '#...#', '#...#', '#...#', '#####']);
    const ghost = buildGhost({ pos: { x: 3, y: 2 }, mode: 'frightened', home: { x: 1, y: 1 } });
    const state = buildState({
      maze,
      pacman: { pos: { x: 2, y: 2 }, dir: 'right' },
      ghosts: [ghost],
      lives: 3,
      frightenedTicks: 5,
    });
    const next = tick(state, 'right');
    expect(next.lives).toBe(3);
    expect(next.score).toBe(210);
  });
});

describe('moveGhost', () => {
  const room = buildMaze([
    '#######',
    '#.....#',
    '#.....#',
    '#.....#',
    '#.....#',
    '#.....#',
    '#######',
  ]);

  it('P0-GAME-008 steps toward pacman while chasing', () => {
    const state = buildState({
      maze: room,
      pacman: { pos: { x: 1, y: 1 }, dir: 'left' },
      ghosts: [buildGhost({ pos: { x: 3, y: 3 }, dir: 'right', mode: 'chase' })],
    });
    const next = tick(state, null);
    expect(next.ghosts[0]?.pos).toEqual({ x: 3, y: 2 });
  });

  it('P0-GAME-008 steps away from pacman while frightened', () => {
    const state = buildState({
      maze: room,
      pacman: { pos: { x: 1, y: 1 }, dir: 'left' },
      ghosts: [buildGhost({ pos: { x: 3, y: 3 }, dir: 'right', mode: 'frightened' })],
      frightenedTicks: 1,
    });
    const next = tick(state, null);
    expect(next.ghosts[0]?.pos).toEqual({ x: 3, y: 4 });
  });
});

describe('checkWin', () => {
  it('P0-GAME-005 declares a win once no dots remain', () => {
    const state = buildState({ dotsRemaining: 0 });
    expect(checkWin(state).status).toBe('won');
  });

  it('P0-GAME-005 keeps playing while dots remain', () => {
    const state = buildState({ dotsRemaining: 1 });
    expect(checkWin(state).status).toBe('playing');
  });
});

describe('loseLife', () => {
  it('P0-GAME-006 respawns pacman and ghosts when lives remain', () => {
    const state = buildState({ lives: 2, ghosts: [buildGhost({ pos: { x: 4, y: 4 } })] });
    const next = loseLife(state);
    expect(next.lives).toBe(1);
    expect(next.status).toBe('playing');
    expect(next.pacman.pos).toEqual(PACMAN_START);
    expect(next.ghosts[0]?.pos).toEqual(next.ghosts[0]?.home);
  });

  it('P0-GAME-006 ends the game when the last life is lost', () => {
    const state = buildState({ lives: 1 });
    const next = loseLife(state);
    expect(next.lives).toBe(0);
    expect(next.status).toBe('lost');
  });
});

describe('createGameState', () => {
  it('builds a playable game with dots on the board and four ghosts', () => {
    const state = createGameState();
    expect(state.status).toBe('playing');
    expect(state.lives).toBe(3);
    expect(state.dotsRemaining).toBeGreaterThan(0);
    expect(state.ghosts).toHaveLength(4);
  });

  it('P0-GAME-009 starts unpaused', () => {
    expect(createGameState().paused).toBe(false);
  });
});

describe('tick', () => {
  it('moves pacman one step per tick and leaves a finished game untouched', () => {
    const state = buildState();
    const next = tick(state, 'right');
    expect(next.pacman.pos).toEqual({ x: 3, y: 2 });

    const finished = buildState({ status: 'won' });
    expect(tick(finished, 'right')).toEqual(finished);
  });

  it('does not move ghosts through walls', () => {
    const maze = buildMaze(['#####', '#...#', '#...#', '#...#', '#####']);
    const state = buildState({ maze, ghosts: [buildGhost({ pos: { x: 1, y: 1 } })] });
    const next = tick(state, null);
    const ghost = next.ghosts[0];
    expect(ghost).toBeDefined();
    expect(maze.grid[ghost?.pos.y ?? 0]?.[ghost?.pos.x ?? 0]).not.toBe('wall');
  });
});

describe('togglePause', () => {
  it('P0-GAME-009 pauses a playing game and resumes it', () => {
    const state = buildState();
    const paused = togglePause(state);
    expect(paused.paused).toBe(true);
    expect(togglePause(paused).paused).toBe(false);
  });

  it('P0-GAME-013 leaves a won game unchanged', () => {
    const won = buildState({ status: 'won' });
    expect(togglePause(won)).toEqual(won);
  });

  it('P0-GAME-013 leaves a lost game unchanged', () => {
    const lost = buildState({ status: 'lost', lives: 0 });
    expect(togglePause(lost)).toEqual(lost);
  });
});

describe('tick while paused', () => {
  it('P0-GAME-010 keeps pacman and every ghost on their tiles', () => {
    const ghosts = [
      buildGhost({ id: 0, pos: { x: 1, y: 1 } }),
      buildGhost({ id: 1, pos: { x: 3, y: 3 }, dir: 'left' }),
    ];
    const state = buildState({ paused: true, ghosts });
    const next = tick(state, 'right');
    expect(next.pacman).toEqual(state.pacman);
    expect(next.ghosts).toEqual(state.ghosts);
  });

  it('P0-GAME-011 eats nothing when pacman faces a dot', () => {
    const state = buildState({ paused: true });
    const next = tick(state, 'right');
    expect(next).toEqual(state);
    expect(next.score).toBe(0);
    expect(next.dotsRemaining).toBe(9);
  });

  it('P0-GAME-011 loses no life with a chasing ghost on pacman', () => {
    const state = buildState({
      paused: true,
      ghosts: [buildGhost({ pos: { x: 2, y: 2 }, mode: 'chase' })],
    });
    const next = tick(state, null);
    expect(next).toEqual(state);
    expect(next.lives).toBe(3);
    expect(next.status).toBe('playing');
  });

  it('P0-GAME-011 scores nothing for a frightened ghost on pacman and keeps the timer', () => {
    const state = buildState({
      paused: true,
      frightenedTicks: 5,
      ghosts: [buildGhost({ pos: { x: 2, y: 2 }, mode: 'frightened' })],
    });
    const next = tick(state, null);
    expect(next).toEqual(state);
    expect(next.score).toBe(0);
    expect(next.frightenedTicks).toBe(5);
    expect(next.ghosts[0]?.mode).toBe('frightened');
  });

  it('P0-GAME-012 moves pacman and the ghosts again once resumed', () => {
    const maze = buildMaze(['#######', '#.....#', '#.....#', '#.....#', '#######']);
    const state = buildState({
      maze,
      dotsRemaining: 15,
      pacman: { pos: { x: 1, y: 2 }, dir: 'right' },
      ghosts: [buildGhost({ pos: { x: 5, y: 1 }, dir: 'left', mode: 'chase' })],
    });
    const paused = togglePause(state);
    expect(tick(paused, 'right').pacman.pos).toEqual({ x: 1, y: 2 });

    const resumed = tick(togglePause(paused), 'right');
    expect(resumed.pacman.pos).toEqual({ x: 2, y: 2 });
    expect(resumed.ghosts[0]?.pos).not.toEqual({ x: 5, y: 1 });
  });
});

type RecordingContext = { ctx: CanvasRenderingContext2D; log: string[] };

// A stand-in canvas context that writes every call and property set to a log, so a test can
// compare what was drawn without a browser.
function recordingContext(): RecordingContext {
  const log: string[] = [];
  const ctx = new Proxy(
    {},
    {
      get:
        (_target, name) =>
        (...args: unknown[]) => {
          log.push(`${String(name)}(${args.join(',')})`);
        },
      set: (_target, name, value) => {
        log.push(`${String(name)}=${String(value)}`);
        return true;
      },
    },
  );
  return { ctx: ctx as unknown as CanvasRenderingContext2D, log };
}

function drawn(state: GameState): string[] {
  const { ctx, log } = recordingContext();
  drawFrame(ctx, state);
  return log;
}

function textsOf(log: string[]): string[] {
  return log.filter((entry) => entry.startsWith('fillText('));
}

describe('pause display', () => {
  it('P0-UI-002 shows Paused in the status line only while paused', () => {
    const state = createGameState();
    expect(statusText(state)).toBe('');
    expect(statusText(togglePause(state))).toBe('Paused');
  });

  it('P0-UI-002 keeps score, lives and the canvas the same across steps while paused', () => {
    const paused = togglePause(createGameState());
    const later = tick(tick(tick(paused, 'left'), 'up'), null);
    expect(later.score).toBe(paused.score);
    expect(later.lives).toBe(paused.lives);
    expect(drawn(later)).toEqual(drawn(paused));
  });

  it('P0-UI-002 draws nothing extra on the canvas for a pause', () => {
    const state = createGameState();
    const running = { ...state, readyTicks: 0 };
    expect(drawn(togglePause(running))).toEqual(drawn(running));
    expect(textsOf(drawn(togglePause(running)))).toEqual([]);
  });
});

describe('score screen', () => {
  it('P0-UI-004 draws YOU WIN and the final score when the game is won', () => {
    const won: GameState = { ...createGameState(), status: 'won', score: 1240 };
    const texts = textsOf(drawn(won));
    expect(texts.some((t) => t.includes('YOU WIN'))).toBe(true);
    expect(texts.some((t) => t.includes('Score: 1240'))).toBe(true);
    expect(texts.some((t) => t.includes('GAME OVER'))).toBe(false);
  });

  it('P0-UI-004 keeps status and score on a won game through tick', () => {
    const won = buildState({ status: 'won', score: 90, dotsRemaining: 0 });
    const next = tick(won, 'right');
    expect(next.status).toBe('won');
    expect(next.score).toBe(90);
  });

  it('P0-UI-005 draws GAME OVER and the final score when the game is lost', () => {
    const lost: GameState = { ...createGameState(), status: 'lost', lives: 0, score: 330 };
    const texts = textsOf(drawn(lost));
    expect(texts.some((t) => t.includes('GAME OVER'))).toBe(true);
    expect(texts.some((t) => t.includes('Score: 330'))).toBe(true);
    expect(texts.some((t) => t.includes('YOU WIN'))).toBe(false);
  });

  it('P0-UI-005 keeps status and score on a lost game through tick', () => {
    const lost = buildState({ status: 'lost', lives: 0, score: 40 });
    const next = tick(lost, 'right');
    expect(next.status).toBe('lost');
    expect(next.score).toBe(40);
  });

  it('P0-UI-004 draws a score screen only when the game has ended', () => {
    expect(textsOf(drawn({ ...createGameState(), readyTicks: 0 }))).toEqual([]);
  });
});

describe('ready message', () => {
  const readyTexts = (state: GameState): string[] =>
    textsOf(drawn(state)).filter((t) => t.startsWith('fillText(READY!,'));

  it('P0-UI-015 shows READY! in the maze when a game starts', () => {
    // canon: CAP-6.1
    const state = createGameState();
    expect(state.readyTicks).toBe(READY_TICKS);
    expect(readyTexts(state)).toHaveLength(1);
  });

  it('P0-UI-015 draws the maze and characters in the same frame as READY!', () => {
    // canon: CAP-6.1
    const state = createGameState();
    const withReady = drawn(state);
    const without = drawn({ ...state, readyTicks: 0 });
    expect(withReady.length).toBeGreaterThan(without.length);
    expect(withReady.filter((e) => e.startsWith('fillRect(')).length).toBe(
      without.filter((e) => e.startsWith('fillRect(')).length,
    );
  });

  it('P0-UI-016 shows READY! again after a life is lost while lives remain', () => {
    // canon: CAP-6.2
    const caught = buildState({
      maze: buildMaze(ROOM),
      ghosts: [buildGhost({ pos: { x: 3, y: 2 }, mode: 'chase' })],
      lives: 3,
    });
    const next = tick(caught, 'right');
    expect(next.lives).toBe(2);
    expect(next.readyTicks).toBe(READY_TICKS);
    expect(readyTexts(next)).toHaveLength(1);
    expect(loseLife(buildState({ lives: 2 })).readyTicks).toBe(READY_TICKS);
  });

  it('P0-GAME-019 shows no READY! when the last life is lost', () => {
    // canon: CAP-6.3
    const lost = loseLife(buildState({ lives: 1 }));
    expect(lost.status).toBe('lost');
    expect(lost.readyTicks).toBe(0);
    expect(readyTexts(lost)).toEqual([]);
    expect(textsOf(drawn(lost)).some((t) => t.includes('GAME OVER'))).toBe(true);
  });

  it('P0-GAME-020 keeps pacman and every ghost still while READY! shows', () => {
    // canon: CAP-6.4
    const ghosts = [
      buildGhost({ id: 0, pos: { x: 1, y: 1 } }),
      buildGhost({ id: 1, pos: { x: 3, y: 3 }, dir: 'left' }),
    ];
    const state = buildState({ readyTicks: READY_TICKS, ghosts });
    const next = tick(state, 'right');
    expect(next.pacman).toEqual(state.pacman);
    expect(next.ghosts).toEqual(state.ghosts);
    expect(next.score).toBe(state.score);
    expect(next.lives).toBe(state.lives);
    expect(next.readyTicks).toBe(READY_TICKS - 1);
  });

  it('P0-GAME-020 holds still for the whole of READY! and keeps the counter while paused', () => {
    // canon: CAP-6.4
    const ghosts = [buildGhost({ pos: { x: 1, y: 1 } })];
    let state = buildState({ readyTicks: READY_TICKS, ghosts });
    for (let i = 0; i < READY_TICKS; i++) {
      state = tick(state, 'right');
      expect(state.pacman.pos).toEqual({ x: 2, y: 2 });
      expect(state.ghosts).toEqual(ghosts);
    }
    const paused = togglePause(buildState({ readyTicks: 5 }));
    expect(tick(paused, 'right').readyTicks).toBe(5);
  });

  it('P0-GAME-021 ends READY! and moves pacman and the ghosts on the next step', () => {
    // canon: CAP-6.5
    const room = buildMaze(['#######', '#.....#', '#.....#', '#.....#', '#######']);
    let state = buildState({
      maze: room,
      dotsRemaining: 15,
      readyTicks: READY_TICKS,
      pacman: { pos: { x: 1, y: 2 }, dir: 'right' },
      ghosts: [buildGhost({ pos: { x: 5, y: 1 }, dir: 'left', mode: 'chase' })],
    });
    for (let i = 0; i < READY_TICKS; i++) state = tick(state, 'right');
    expect(state.readyTicks).toBe(0);
    expect(readyTexts(state)).toEqual([]);

    const moved = tick(state, 'right');
    expect(moved.pacman.pos).toEqual({ x: 2, y: 2 });
    expect(moved.ghosts[0]?.pos).not.toEqual({ x: 5, y: 1 });
  });
});

// The point amounts belong to CAP-1.3 and CAP-1.4. game.ts does not export them, so each test reads
// an amount from the rule that awards it and never writes it as a literal.
const ROOM = ['#####', '#...#', '#.. #', '#...#', '#####'];
const AT = { x: 2, y: 2 };

function dotPoints(): number {
  const state = buildState();
  return eatDot(state, AT).score - state.score;
}

function pelletPoints(): number {
  const state = buildState({ maze: buildMaze(['#####', '#...#', '#.o.#', '#...#', '#####']) });
  return eatDot(state, AT).score - state.score;
}

function ghostPoints(): number {
  const ghost = buildGhost({ pos: AT, mode: 'frightened' });
  const state = buildState({ ghosts: [ghost] });
  return resolveGhostCollisions(state).score - state.score;
}

// What main.ts render() writes into #score on every frame. main.ts reads the DOM when it loads, so
// it cannot be imported here and the string is repeated.
function hudScore(state: GameState): string {
  return `Score: ${state.score}`;
}

function scoreScreenText(state: GameState): string[] {
  return textsOf(drawn(state)).filter((entry) => entry.startsWith('fillText(Score: '));
}

function pageHtml(): string {
  return readFileSync(new URL('../index.html', import.meta.url), 'utf8');
}

describe('in-play score display', () => {
  it('P0-UI-009 reads Score: 0 in the page and in a new game before anything is eaten', () => {
    // canon: CAP-4.1
    expect(/<span id="score">([^<]*)<\/span>/.exec(pageHtml())?.[1]).toBe('Score: 0');

    const state = createGameState();
    expect(hudScore(state)).toBe('Score: 0');
    expect(hudScore(tick(state, null))).toBe('Score: 0');
    expect(hudScore(tick(togglePause(state), 'left'))).toBe('Score: 0');
  });

  it('P0-UI-010 puts the score and the lives side by side in one flex row', () => {
    // canon: CAP-4.2
    const html = pageHtml();
    const hud = /<div id="hud">([\s\S]*?)<\/div>/.exec(html)?.[1] ?? '';
    const spans = [...hud.matchAll(/<span id="([^"]+)">([^<]*)<\/span>/g)].map((m) => [m[1], m[2]]);
    // The best-score span (CAP-9) follows score and lives; its placement is a changeable default.
    expect(spans.slice(0, 2)).toEqual([
      ['score', 'Score: 0'],
      ['lives', `Lives: ${createGameState().lives}`],
    ]);

    const rule = /#hud\s*\{([^}]*)\}/.exec(html)?.[1] ?? '';
    expect(rule).toMatch(/display:\s*flex/);
    expect(rule).not.toMatch(/flex-direction:\s*column/);
  });

  it('P0-UI-011 raises the displayed score by the dot amount when a dot is eaten', () => {
    // canon: CAP-4.3
    const before = buildState({ score: 70 });
    const after = tick(before, 'right');
    expect(before.maze.grid[2]?.[3]).toBe('dot');
    expect(after.maze.grid[2]?.[3]).toBe('empty');
    expect(dotPoints()).toBeGreaterThan(0);
    expect(hudScore(after)).toBe(`Score: ${before.score + dotPoints()}`);
  });

  it('P0-UI-012 raises the displayed score by the pellet amount when a pellet is eaten', () => {
    // canon: CAP-4.4
    const maze = buildMaze(['#####', '#...#', '#..o#', '#...#', '#####']);
    const before = buildState({ maze, score: 70 });
    const after = tick(before, 'right');
    expect(after.maze.grid[2]?.[3]).toBe('empty');
    expect(after.frightenedTicks).toBeGreaterThan(0);
    expect(pelletPoints()).toBeGreaterThan(dotPoints());
    expect(hudScore(after)).toBe(`Score: ${before.score + pelletPoints()}`);
  });

  it('P0-UI-013 raises the displayed score by the ghost amount when a frightened ghost is caught', () => {
    // canon: CAP-4.5
    const ghost = buildGhost({ pos: { x: 3, y: 2 }, mode: 'frightened', home: { x: 1, y: 1 } });
    const before = buildState({
      maze: buildMaze(ROOM),
      ghosts: [ghost],
      frightenedTicks: 5,
      score: 70,
    });
    const after = tick(before, 'right');
    expect(after.lives).toBe(before.lives);
    expect(after.ghosts[0]?.mode).toBe('returning');
    expect(ghostPoints()).toBeGreaterThan(0);
    expect(hudScore(after)).toBe(`Score: ${before.score + ghostPoints()}`);
  });

  it('P0-UI-013 leaves the displayed score alone when a chasing ghost costs a life', () => {
    // canon: CAP-4.5
    const before = buildState({
      maze: buildMaze(ROOM),
      ghosts: [buildGhost({ pos: { x: 3, y: 2 }, mode: 'chase' })],
      score: 70,
    });
    const after = tick(before, 'right');
    expect(after.lives).toBe(before.lives - 1);
    expect(hudScore(after)).toBe(hudScore(before));
  });

  it('P0-UI-014 shows the last displayed score on the win screen', () => {
    // canon: CAP-4.6
    const lastDot = buildMaze(['#####', '#   #', '#  .#', '#   #', '#####']);
    const before = buildState({ maze: lastDot, dotsRemaining: 1, score: 120 });
    const won = tick(before, 'right');
    const shown = before.score + dotPoints();

    expect(won.status).toBe('won');
    expect(hudScore(won)).toBe(`Score: ${shown}`);
    expect(scoreScreenText(won)).toEqual([expect.stringMatching(`^fillText\\(Score: ${shown},`)]);

    const later = tick(tick(won, 'left'), 'up');
    expect(hudScore(later)).toBe(hudScore(won));
    expect(scoreScreenText(later)).toEqual(scoreScreenText(won));
  });

  it('P0-UI-014 shows the last displayed score on the game-over screen', () => {
    // canon: CAP-4.6
    const before = buildState({
      maze: buildMaze(ROOM),
      ghosts: [buildGhost({ pos: { x: 3, y: 2 }, mode: 'chase' })],
      lives: 1,
      score: 120,
    });
    const lost = tick(before, 'right');

    expect(lost.status).toBe('lost');
    expect(hudScore(lost)).toBe(hudScore(before));
    expect(scoreScreenText(lost)).toEqual([
      expect.stringMatching(`^fillText\\(Score: ${before.score},`),
    ]);

    const later = tick(tick(lost, 'left'), 'up');
    expect(scoreScreenText(later)).toEqual(scoreScreenText(lost));
  });
});

describe('dots left display', () => {
  it('P0-UI-020 starts at the number of dots and pellets in the maze', () => {
    // canon: CAP-4.7
    const state = createGameState();
    const total = countRemaining(createMaze());
    expect(total).toBeGreaterThan(0);
    expect(state.dotsRemaining).toBe(total);
    expect(state.dotsTotal).toBe(total);
    expect(dotsText(state)).toBe(`Dots left: ${total}`);
    expect(/<span id="dots">([^<]*)<\/span>/.exec(pageHtml())).not.toBeNull();
  });

  it('P0-UI-021 lowers the count by exactly one when a dot is eaten', () => {
    // canon: CAP-4.8
    const before = buildState();
    const after = tick(before, 'right');
    expect(before.maze.grid[2]?.[3]).toBe('dot');
    expect(after.dotsRemaining).toBe(before.dotsRemaining - 1);
    expect(dotsText(after)).toBe(`Dots left: ${before.dotsRemaining - 1}`);
    expect(eatDot(before, { x: 3, y: 2 }).dotsRemaining).toBe(before.dotsRemaining - 1);
  });

  it('P0-UI-021 leaves the count alone on an empty tile, when paused, and on READY!', () => {
    // canon: CAP-4.8
    const before = buildState();
    expect(eatDot(tick(before, 'right'), { x: 3, y: 2 }).dotsRemaining).toBe(8);
    expect(tick(togglePause(before), 'right').dotsRemaining).toBe(before.dotsRemaining);
    expect(tick(buildState({ readyTicks: READY_TICKS }), 'right').dotsRemaining).toBe(
      before.dotsRemaining,
    );
    expect(loseLife(before).dotsRemaining).toBe(before.dotsRemaining);
  });

  it('P0-UI-021 lowers the count by two when a boosted tick clears two cells', () => {
    // canon: CAP-4.8
    const before = buildState({
      maze: buildMaze(['######', '#....#', '######']),
      pacman: { pos: { x: 1, y: 1 }, dir: 'right' },
      dotsRemaining: 4,
      dotsTotal: 4,
      boostTicks: BOOST_DURATION,
    });
    const after = tick(before, 'right');
    expect(BOOST_SPEED_MULTIPLIER).toBeGreaterThanOrEqual(2);
    expect(after.pacman.pos.x).toBe(3);
    expect(after.dotsRemaining).toBe(2);
  });

  it('P0-UI-022 lowers the count by exactly one when a power pellet is eaten', () => {
    // canon: CAP-4.9
    const maze = buildMaze(['#####', '#...#', '#..o#', '#...#', '#####']);
    const before = buildState({ maze });
    const after = tick(before, 'right');
    expect(after.maze.grid[2]?.[3]).toBe('empty');
    expect(after.dotsRemaining).toBe(before.dotsRemaining - 1);
    expect(dotsText(after)).toBe(`Dots left: ${before.dotsRemaining - 1}`);
  });

  it('P0-UI-023 shows Dots left in the page between lives and best, and 0 after the last dot', () => {
    // canon: CAP-4.10
    const hud = /<div id="hud">([\s\S]*?)<\/div>/.exec(pageHtml())?.[1] ?? '';
    const ids = [...hud.matchAll(/<span id="([^"]+)">/g)].map((m) => m[1]);
    expect(ids.indexOf('dots')).toBe(ids.indexOf('lives') + 1);
    expect(ids.indexOf('best')).toBe(ids.indexOf('dots') + 1);

    const lastDot = buildMaze(['#####', '#   #', '#  .#', '#   #', '#####']);
    const won = tick(buildState({ maze: lastDot, dotsRemaining: 1, dotsTotal: 1 }), 'right');
    expect(won.status).toBe('won');
    expect(dotsText(won)).toBe('Dots left: 0');
  });
});

// The fruit rules are private to game.ts, so these tests drive them through tick and createGameState.

// pacman at (2,2) facing the dot at (3,2): one tick right eats it.
function nearHalf(dotsTotal: number, dotsRemaining: number): GameState {
  return buildState({ dotsTotal, dotsRemaining });
}

// A real maze with pacman one tile left of the fruit tile, which is cleared so only the fruit scores.
function besideFruit(fruit: GameState['fruit']): GameState {
  const base = createGameState();
  const grid = base.maze.grid.map((row) => [...row]);
  const row = grid[FRUIT_POS.y];
  if (row) row[FRUIT_POS.x] = 'empty';
  return {
    ...base,
    readyTicks: 0,
    maze: { ...base.maze, grid },
    ghosts: [],
    pacman: { pos: { x: FRUIT_POS.x - 1, y: FRUIT_POS.y }, dir: 'right' },
    fruit,
  };
}

describe('bonus fruit appearing', () => {
  it('P0-GAME-014 waits in a fresh game and sits on a walkable tile', () => {
    // canon: CAP-5.1
    const state = createGameState();
    expect(state.fruit).toEqual({ phase: 'waiting', ticksLeft: 0 });
    expect(isWalkable(createMaze(), FRUIT_POS)).toBe(true);
  });

  it('P0-GAME-014 does not appear one dot below half, odd total', () => {
    // canon: CAP-5.1
    expect(tick(nearHalf(9, 6), 'right').fruit.phase).toBe('waiting');
  });

  it('P0-GAME-014 appears exactly at half, odd total', () => {
    // canon: CAP-5.1
    expect(tick(nearHalf(9, 5), 'right').fruit.phase).toBe('active');
  });

  it('P0-GAME-014 does not appear one dot below half, even total', () => {
    // canon: CAP-5.1
    expect(tick(nearHalf(8, 6), 'right').fruit.phase).toBe('waiting');
  });

  it('P0-GAME-014 appears exactly at half, even total', () => {
    // canon: CAP-5.1
    expect(tick(nearHalf(8, 5), 'right').fruit.phase).toBe('active');
  });

  it('P0-GAME-014 is drawn on its tile only while it is showing', () => {
    // canon: CAP-5.1
    const waiting = createGameState();
    const active: GameState = { ...waiting, fruit: { phase: 'active', ticksLeft: 5 } };
    const cx = FRUIT_POS.x * TILE + TILE / 2;
    const cy = FRUIT_POS.y * TILE + TILE / 2;
    const arcAtFruit = (log: string[]): boolean =>
      log.some((entry) => entry.startsWith(`arc(${cx},${cy},`));
    expect(arcAtFruit(drawn(waiting))).toBe(false);
    expect(arcAtFruit(drawn(active))).toBe(true);
  });
});

describe('bonus fruit expiring', () => {
  it('P0-GAME-015 counts down one per tick, then disappears with the score unchanged', () => {
    // canon: CAP-5.2
    let state = buildState({ fruit: { phase: 'active', ticksLeft: 3 } });
    state = tick(state, null);
    expect(state.fruit).toEqual({ phase: 'active', ticksLeft: 2 });
    state = tick(tick(state, null), null);
    expect(state.fruit.phase).toBe('done');
    expect(state.score).toBe(0);
  });

  it('P0-GAME-015 stops being drawn once it has disappeared', () => {
    // canon: CAP-5.2
    const done: GameState = { ...createGameState(), fruit: { phase: 'done', ticksLeft: 0 } };
    expect(drawn(done)).toEqual(drawn(createGameState()));
  });

  it('P0-GAME-015 freezes while paused and continues after a lost life', () => {
    // canon: CAP-5.2
    const fruit = { phase: 'active' as const, ticksLeft: 5 };
    const paused = togglePause(buildState({ fruit }));
    expect(tick(paused, null).fruit).toEqual(fruit);

    const caught = buildState({
      fruit,
      ghosts: [buildGhost({ pos: { x: 2, y: 2 }, home: { x: 1, y: 1 } })],
    });
    const next = tick(caught, null);
    expect(next.lives).toBe(2);
    expect(next.fruit).toEqual({ phase: 'active', ticksLeft: 4 });
  });
});

describe('bonus fruit eating', () => {
  it('P0-GAME-016 is eaten and removed when pacman reaches it while showing', () => {
    // canon: CAP-5.3
    const next = tick(besideFruit({ phase: 'active', ticksLeft: 10 }), 'right');
    expect(next.pacman.pos).toEqual(FRUIT_POS);
    expect(next.fruit.phase).toBe('done');
    expect(next.score).toBeGreaterThan(0);
  });

  it('P0-GAME-016 is not eaten while waiting or after it is done', () => {
    // canon: CAP-5.3
    const waiting = tick(besideFruit({ phase: 'waiting', ticksLeft: 0 }), 'right');
    const done = tick(besideFruit({ phase: 'done', ticksLeft: 0 }), 'right');
    expect(waiting.score).toBe(0);
    expect(waiting.fruit.phase).toBe('waiting');
    expect(done.score).toBe(0);
  });

  it('P0-GAME-017 raises the score by more than a power pellet is worth', () => {
    // canon: CAP-5.4
    const next = tick(besideFruit({ phase: 'active', ticksLeft: 10 }), 'right');
    expect(next.score).toBeGreaterThan(pelletPoints());
  });
});

describe('bonus fruit once per game', () => {
  const PATH: ('right' | 'up' | 'left' | 'down')[] = [
    'right',
    'up',
    'left',
    'left',
    'down',
    'down',
    'right',
    'right',
    'up',
    'left',
  ];

  function phasesPlayed(fruit: GameState['fruit']): string[] {
    let state = buildState({ fruit });
    const phases: string[] = [];
    for (const dir of PATH) {
      state = tick(state, dir);
      phases.push(state.fruit.phase);
    }
    expect(state.status).toBe('won');
    return phases;
  }

  it('P0-GAME-018 shows at most one run in a game played to a win', () => {
    // canon: CAP-5.5
    const phases = phasesPlayed({ phase: 'waiting', ticksLeft: 0 });
    expect(phases).toContain('active');
    const first = phases.indexOf('active');
    const last = phases.lastIndexOf('active');
    expect(phases.slice(first, last + 1).every((p) => p === 'active')).toBe(true);
  });

  it('P0-GAME-018 never comes back once it was eaten or expired', () => {
    // canon: CAP-5.5
    const phases = phasesPlayed({ phase: 'done', ticksLeft: 0 });
    expect(phases.every((p) => p === 'done')).toBe(true);
  });

  it('P0-GAME-018 does not reappear after expiring when more dots are eaten', () => {
    // canon: CAP-5.5
    const expired = tick(buildState({ fruit: { phase: 'active', ticksLeft: 1 } }), null);
    expect(expired.fruit.phase).toBe('done');
    const later = tick({ ...expired, dotsTotal: 9, dotsRemaining: 5 }, 'right');
    expect(later.fruit.phase).toBe('done');
  });
});

const BIG_ROOM = buildMaze([
  '#######',
  '#.....#',
  '#.....#',
  '#.....#',
  '#.....#',
  '#.....#',
  '#######',
]);

const distance = (a: { x: number; y: number }, b: { x: number; y: number }): number =>
  Math.abs(a.x - b.x) + Math.abs(a.y - b.y);

describe('eaten ghost returns home', () => {
  it('P0-GAME-022 turns a touched frightened ghost into a returning one where it stands', () => {
    // canon: CAP-7.1
    const ghost = buildGhost({ pos: AT, mode: 'frightened', home: { x: 1, y: 1 } });
    const next = resolveGhostCollisions(buildState({ ghosts: [ghost], lives: 3 }));
    expect(next.ghosts[0]?.mode).toBe('returning');
    expect(next.ghosts[0]?.pos).toEqual(AT);
    expect(next.score).toBe(ghostPoints());
    expect(next.lives).toBe(3);
  });

  it('P0-GAME-023 costs no life and scores nothing when a returning ghost touches pacman', () => {
    // canon: CAP-7.2
    const ghost = buildGhost({ pos: AT, mode: 'returning', home: { x: 1, y: 1 } });
    const state = buildState({ ghosts: [ghost], lives: 3, score: 40 });
    expect(resolveGhostCollisions(state)).toEqual(state);

    const moved = tick({ ...state, ghosts: [{ ...ghost, pos: { x: 3, y: 2 } }] }, 'right');
    expect(moved.lives).toBe(3);
    expect(moved.score).toBe(40 + dotPoints());
  });

  it('P0-GAME-024 moves a returning ghost one step closer to home, ignoring pacman', () => {
    // canon: CAP-7.3
    const from = { x: 5, y: 5 };
    const home = { x: 1, y: 1 };
    const state = buildState({
      maze: BIG_ROOM,
      pacman: { pos: { x: 5, y: 4 }, dir: 'left' },
      ghosts: [buildGhost({ pos: from, dir: 'down', mode: 'returning', home })],
    });
    const ghost = tick(state, null).ghosts[0];
    expect(ghost?.mode).toBe('returning');
    expect(isWalkable(BIG_ROOM, ghost?.pos ?? { x: 0, y: 0 })).toBe(true);
    expect(distance(ghost?.pos ?? from, home)).toBe(distance(from, home) - 1);
    expect(ghost?.pos).not.toEqual(from);
  });

  it('P0-GAME-024 leaves a returning ghost where it is while paused', () => {
    // canon: CAP-7.3
    const ghost = buildGhost({ pos: { x: 5, y: 5 }, mode: 'returning', home: { x: 1, y: 1 } });
    const state = togglePause(buildState({ maze: BIG_ROOM, ghosts: [ghost] }));
    expect(tick(state, null).ghosts[0]).toEqual(ghost);
  });

  it('P0-GAME-025 walks an eaten ghost through the door to its home cell, then chases', () => {
    // canon: CAP-7.4
    const maze = createMaze();
    const home = { x: 9, y: 9 };
    const eaten = buildGhost({ pos: { x: 9, y: 6 }, mode: 'returning', home });
    let state: GameState = {
      ...createGameState(),
      readyTicks: 0,
      ghosts: [eaten],
    };
    const visited: string[] = [];
    for (let i = 0; i < 20 && state.ghosts[0]?.mode === 'returning'; i++) {
      state = tick(state, null);
      visited.push(`${state.ghosts[0]?.pos.x},${state.ghosts[0]?.pos.y}`);
    }
    expect(maze.grid[8]?.[9]).toBe('empty');
    expect(visited).toContain('9,8');
    expect(state.ghosts[0]?.pos).toEqual(home);
    expect(state.ghosts[0]?.mode).toBe('chase');
    expect(tick(state, null).ghosts[0]?.pos).not.toEqual(home);
  });

  it('P0-GAME-026 does not frighten a returning ghost when a pellet is eaten', () => {
    // canon: CAP-7.5
    const maze = buildMaze(['#####', '#...#', '#.o.#', '#...#', '#####']);
    const state = buildState({
      maze,
      ghosts: [
        buildGhost({ id: 0, mode: 'returning', pos: { x: 3, y: 3 } }),
        buildGhost({ id: 1, mode: 'chase', pos: { x: 3, y: 1 } }),
      ],
    });
    const next = eatDot(state, AT);
    expect(next.frightenedTicks).toBeGreaterThan(0);
    expect(next.ghosts.map((g) => g.mode)).toEqual(['returning', 'frightened']);
  });

  it('P0-GAME-027 keeps a ghost returning when frightened mode ends, until it is home', () => {
    // canon: CAP-7.6
    const home = { x: 1, y: 1 };
    const state = buildState({
      maze: BIG_ROOM,
      pacman: { pos: { x: 1, y: 5 }, dir: 'left' },
      frightenedTicks: 1,
      ghosts: [
        buildGhost({ id: 0, pos: { x: 5, y: 5 }, dir: 'down', mode: 'returning', home }),
        buildGhost({ id: 1, pos: { x: 5, y: 1 }, dir: 'left', mode: 'frightened', home }),
      ],
    });
    let next = tick(state, null);
    expect(next.frightenedTicks).toBe(0);
    expect(next.ghosts.map((g) => g.mode)).toEqual(['returning', 'chase']);

    for (let i = 0; i < 20 && next.ghosts[0]?.mode === 'returning'; i++) next = tick(next, null);
    expect(next.ghosts[0]?.mode).toBe('chase');
    expect(next.ghosts[0]?.pos).toEqual(home);
  });

  it('P0-GAME-028 puts a returning ghost on its home cell chasing when a life is lost', () => {
    // canon: CAP-7.7
    const ghost = buildGhost({ pos: { x: 3, y: 3 }, mode: 'returning', home: { x: 1, y: 2 } });
    const next = loseLife(buildState({ lives: 2, ghosts: [ghost] }));
    expect(next.ghosts[0]?.pos).toEqual({ x: 1, y: 2 });
    expect(next.ghosts[0]?.mode).toBe('chase');
  });

  it('P0-GAME-028 starts a new game with every ghost on its home cell chasing', () => {
    // canon: CAP-7.7
    const { ghosts } = createGameState();
    expect(ghosts.every((g) => g.mode === 'chase')).toBe(true);
    expect(ghosts.every((g) => g.pos.x === g.home.x && g.pos.y === g.home.y)).toBe(true);
  });

  it('P0-UI-017 draws a returning ghost in a colour unlike chasing and frightened ghosts', () => {
    // canon: CAP-7.8
    const fillOf = (mode: Ghost['mode']): string | undefined => {
      const state = buildState({ ghosts: [buildGhost({ mode })] });
      const log = drawn(state);
      const rect = `fillRect(${1 * TILE + 2},${1 * TILE + 2},${TILE - 4},${TILE - 4})`;
      const at = log.indexOf(rect);
      return log
        .slice(0, at)
        .reverse()
        .find((entry) => entry.startsWith('fillStyle='));
    };
    const colours = [fillOf('chase'), fillOf('frightened'), fillOf('returning')];
    expect(colours.every((c) => c !== undefined)).toBe(true);
    expect(new Set(colours).size).toBe(3);
  });
});

// A long corridor on row 1, pacman at x=1, so a boosted tick has room to run.
const LANE = buildMaze(['####################', '#..................#', '####################']);
const laneState = (overrides: Partial<GameState> = {}): GameState =>
  buildState({
    maze: LANE,
    pacman: { pos: { x: 1, y: 1 }, dir: 'right' },
    dotsRemaining: 18,
    dotsTotal: 36,
    ...overrides,
  });
const atStart = (state: GameState): GameState => ({
  ...state,
  pacman: { pos: { x: 1, y: 1 }, dir: 'right' },
});

describe('speed boost after a power pellet', () => {
  it('P0-GAME-029 starts the boost on a power pellet and leaves it alone on a dot', () => {
    // canon: CAP-8.1
    const maze = buildMaze(['#####', '#o..#', '#...#', '#...#', '#####']);
    const pellet = eatDot(buildState({ maze }), { x: 1, y: 1 });
    expect(pellet.boostTicks).toBe(BOOST_DURATION);
    expect(eatDot(buildState(), { x: 2, y: 2 }).boostTicks).toBe(0);
  });

  it('P0-GAME-029 moves one cell on the pellet tick and boosts from the next tick', () => {
    // canon: CAP-8.1
    const maze = buildMaze([
      '####################',
      '#.o................#',
      '####################',
    ]);
    const eating = tick(laneState({ maze }), 'right');
    expect(eating.pacman.pos.x).toBe(2);
    expect(eating.boostTicks).toBe(BOOST_DURATION);
    expect(tick(eating, 'right').pacman.pos.x).toBe(2 + BOOST_SPEED_MULTIPLIER);
  });

  it('P0-GAME-030 moves the multiplier of cells per tick while boosted and one when not', () => {
    // canon: CAP-8.2
    const boosted = tick(laneState({ boostTicks: 5 }), 'right');
    expect(boosted.pacman.pos.x).toBe(1 + BOOST_SPEED_MULTIPLIER);
    expect(tick(laneState(), 'right').pacman.pos.x).toBe(2);
  });

  it('P0-GAME-030 stops at a wall without error and keeps ghosts at one cell per tick', () => {
    // canon: CAP-8.2
    const maze = buildMaze(['#####', '#...#', '#####']);
    const near = tick(
      buildState({ maze, pacman: { pos: { x: 3, y: 1 }, dir: 'right' }, boostTicks: 5 }),
      'right',
    );
    expect(near.pacman.pos).toEqual({ x: 3, y: 1 });

    const ghost = buildGhost({ pos: { x: 18, y: 1 }, dir: 'left', home: { x: 18, y: 1 } });
    const next = tick(laneState({ boostTicks: 5, ghosts: [ghost] }), 'right');
    expect(next.ghosts[0]?.pos.x).toBe(17);
  });

  it('P0-GAME-031 lasts exactly the boost duration in ticks', () => {
    // canon: CAP-8.3
    let state = laneState({ boostTicks: BOOST_DURATION });
    for (let i = 0; i < BOOST_DURATION; i++) {
      expect(state.boostTicks).toBe(BOOST_DURATION - i);
      state = tick(atStart(state), 'right');
      expect(state.pacman.pos.x).toBe(1 + BOOST_SPEED_MULTIPLIER);
    }
    expect(state.boostTicks).toBe(0);
    const after = tick(atStart(state), 'right');
    expect(after.pacman.pos.x).toBe(2);
    expect(after.boostTicks).toBe(0);
  });

  it('P0-GAME-032 refreshes the boost on a second pellet without adding time or speed', () => {
    // canon: CAP-8.4
    const maze = buildMaze([
      '####################',
      '#.o................#',
      '####################',
    ]);
    const next = tick(laneState({ maze, boostTicks: 3 }), 'right');
    expect(next.boostTicks).toBe(BOOST_DURATION);
    expect(next.pacman.pos.x).toBe(1 + BOOST_SPEED_MULTIPLIER);
    const again = tick(atStart(next), 'right');
    expect(again.pacman.pos.x).toBe(1 + BOOST_SPEED_MULTIPLIER);
    expect(again.boostTicks).toBe(BOOST_DURATION - 1);
  });

  it('P0-GAME-033 eats and scores each dot crossed in a boosted tick', () => {
    // canon: CAP-8.5
    const next = tick(laneState({ boostTicks: 5 }), 'right');
    expect(next.score).toBe(10 * BOOST_SPEED_MULTIPLIER);
    expect(next.dotsRemaining).toBe(18 - BOOST_SPEED_MULTIPLIER);
  });

  it('P0-GAME-033 eats a frightened ghost met on a boosted step', () => {
    // canon: CAP-8.5
    const ghost = buildGhost({ pos: { x: 2, y: 1 }, mode: 'frightened', home: { x: 18, y: 1 } });
    const next = tick(laneState({ boostTicks: 5, frightenedTicks: 10, ghosts: [ghost] }), 'right');
    expect(next.score).toBeGreaterThanOrEqual(200);
    expect(next.ghosts[0]?.mode).toBe('returning');
  });

  it('P0-GAME-033 stops pacman where a chasing ghost costs a life', () => {
    // canon: CAP-8.5
    const ghost = buildGhost({ pos: { x: 2, y: 1 }, home: { x: 18, y: 1 } });
    const next = tick(laneState({ boostTicks: 5, ghosts: [ghost] }), 'right');
    expect(next.lives).toBe(2);
    expect(next.pacman.pos).toEqual(PACMAN_START);
    expect(next.boostTicks).toBe(0);
  });

  it('P0-GAME-033 wins on the last dot and moves no further', () => {
    // canon: CAP-8.5
    const maze = buildMaze(['#####', '#.. #', '#####']);
    const state = buildState({
      maze,
      pacman: { pos: { x: 1, y: 1 }, dir: 'right' },
      dotsRemaining: 1,
      boostTicks: 5,
    });
    const next = tick(state, 'right');
    expect(next.status).toBe('won');
    expect(next.pacman.pos).toEqual({ x: 2, y: 1 });
  });

  it('P0-GAME-034 does not count the boost down while paused or during READY!', () => {
    // canon: CAP-8.6
    const paused = tick(laneState({ boostTicks: 7, paused: true }), 'right');
    expect(paused.boostTicks).toBe(7);
    const ready = tick(laneState({ boostTicks: 7, readyTicks: 3 }), 'right');
    expect(ready.boostTicks).toBe(7);
    expect(ready.pacman.pos.x).toBe(1);
  });

  it('P0-GAME-035 ends the boost when a life is lost or a new game starts', () => {
    // canon: CAP-8.7
    expect(loseLife(buildState({ lives: 2, boostTicks: 9 })).boostTicks).toBe(0);
    expect(createGameState().boostTicks).toBe(0);
  });
});
