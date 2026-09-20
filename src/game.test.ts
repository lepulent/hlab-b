import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Cell, Maze } from './maze';
import { PACMAN_START } from './maze';
import { drawFrame, statusText } from './render';
import {
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
    frightenedTicks: 0,
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

  it('P0-GAME-004 removes a frightened ghost and awards points without costing a life', () => {
    const ghost = buildGhost({ pos: { x: 2, y: 2 }, mode: 'frightened', home: { x: 3, y: 3 } });
    const state = buildState({ ghosts: [ghost], lives: 3 });
    const next = resolveGhostCollisions(state);
    expect(next.lives).toBe(3);
    expect(next.score).toBe(200);
    expect(next.ghosts[0]?.pos).toEqual({ x: 3, y: 3 });
    expect(next.ghosts[0]?.mode).toBe('chase');
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
    expect(drawn(togglePause(state))).toEqual(drawn(state));
    expect(textsOf(drawn(togglePause(state)))).toEqual([]);
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
    expect(textsOf(drawn(createGameState()))).toEqual([]);
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
    expect(spans).toEqual([
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
    expect(after.ghosts[0]?.mode).toBe('chase');
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
