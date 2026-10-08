// Rooms, step 16a (Mycelium tech-spec-m11-rooms §§ room record, workspaces, tripwire; prototype
// prototypes/master-rooms/lib/room.mjs). Pure rules, no I/O: what a room may be convened as, what it is
// estimated to cost, what each seat was staged, whether a read-only seat left its workspace as it found
// it, whether it reached outside it, whether planted evidence stayed with its owner, and the room's
// state folded from its ledger lines. The runner (room-run.mjs) does the I/O.

import { treeDelta } from './record.mjs';

export const ROOM_ACTIONS = { read: ['Read'], investigate: ['Read', 'Glob', 'Grep'] };
// what a read-only seat is denied at the call; the tripwire, not this list, is the guard
export const ROOM_DENIED = [
  'Write',
  'Edit',
  'MultiEdit',
  'NotebookEdit',
  'Bash',
  'WebFetch',
  'WebSearch',
];
export const ROOM_EVENTS = ['convened', 'sitting', 'round', 'ended'];
export const ROOM_TERMINALS = ['complete', 'escalated', 'blocked', 'abandoned'];
const QUESTION_TYPES = ['open', 'bounded', 'closed'];
// spec: $0.25 per seat-turn, $0.03 per round when a conductor chooses the speaker
const SEAT_TURN_USD = 0.25;
const CONDUCTOR_USD = 0.03;

// The record refuses what a room cannot be (prototype validateRoomParams): a seat that acts is not a
// room (requires-f2), a room of more than one seat that can never meet a second round cannot reach a
// disagreement, and a room with no budget cannot be priced. Every refusal names itself.
export function validateRoomParams(p = {}) {
  const refusals = [];
  const seats = p.seats || [];
  const rounds = p.termination?.maxRounds;
  const q = p.question || {};
  if (p.action === 'execute') refusals.push('requires-f2: a room reads, it does not execute');
  else if (!ROOM_ACTIONS[p.action])
    refusals.push(`action "${p.action}" is not one of ${Object.keys(ROOM_ACTIONS).join(', ')}`);
  if (seats.length < 1 || seats.length > 5) refusals.push(`seats ${seats.length}: 1 to 5`);
  if (!Number.isInteger(rounds) || rounds < 1 || rounds > 5)
    refusals.push(`rounds ${rounds}: 1 to 5`);
  if (!QUESTION_TYPES.includes(q.type))
    refusals.push(`question type "${q.type}" is not one of ${QUESTION_TYPES.join(', ')}`);
  if (!String(q.text || '').trim()) refusals.push('question has no text');
  if (q.type === 'closed' && !(q.checklist || []).length)
    refusals.push('a closed question has no checklist');
  if (seats.length > 1 && q.type !== 'closed' && rounds < 2)
    refusals.push('cannot-reach-disagreement: more than one seat, an open question, one round');
  if (!(p.budgetUsd > 0)) refusals.push('budget must be above $0');
  const ids = seats.map((s) => s.id);
  if (new Set(ids).size !== ids.length) refusals.push('seat ids repeat');
  if (seats.some((s) => !/^[a-z][\w-]*$/.test(String(s.id || ''))))
    refusals.push('a seat id is not a plain name');
  return { ok: !refusals.length, refusals };
}

// The pre-flight price, refused with its arithmetic when over budget, never clamped
export function estimateRoomUsd(p) {
  const seats = (p.seats || []).length;
  const rounds = p.termination?.maxRounds || 1;
  const conducted = p.addressing === 'conducted';
  const usd = seats * rounds * SEAT_TURN_USD + (conducted ? rounds * CONDUCTOR_USD : 0);
  const arithmetic = `${seats} seat(s) × ${rounds} round(s) × $${SEAT_TURN_USD}${conducted ? ` + ${rounds} × $${CONDUCTOR_USD}` : ''} = $${usd.toFixed(2)}`;
  return { usd, arithmetic, within: usd <= p.budgetUsd };
}

// A seat's staged manifest: what it was given, by content, so what it read can be named afterwards
export function stagedManifest(seatId, files) {
  return {
    seat: seatId,
    files: files
      .map((f) => ({ path: f.path, from: f.from, sha256: f.sha256 }))
      .sort((a, b) => (a.path < b.path ? -1 : 1)),
  };
}

// The tripwire: a read-only seat's workspace (its own and the shared one) snapshotted before and after
// its turn; the diff must be []. Snapshots map a path to its content hash (record.mjs treeDelta).
export function tripwire(before, after) {
  const diff = treeDelta(before, after);
  return { held: diff.length === 0, diff };
}

// Reach: every path a seat's footprint names lies under its own workspace or the shared one. A target
// that is a pattern (Glob, Grep) with no directory is relative to the seat's cwd, so it is inside.
export function reachHeld(footprint, roots) {
  const outside = (footprint || [])
    .map((f) => f.target)
    .filter((t) => t && t.startsWith('/') && !roots.some((r) => t === r || t.startsWith(`${r}/`)));
  return { held: outside.length === 0, outside: [...new Set(outside)] };
}

// Planted evidence stays with its owner: each canary appears in its owner's stream and in no other.
// Streams are what each seat's session read and said (its transcript text).
export function canaryContainment(canaries, streams) {
  const rows = Object.entries(canaries).map(([owner, canary]) => {
    const seenBy = Object.entries(streams)
      .filter(([, text]) => String(text || '').includes(canary))
      .map(([id]) => id);
    return { owner, canary, seenBy, held: seenBy.length === 1 && seenBy[0] === owner };
  });
  return { held: rows.every((r) => r.held), rows };
}

// The room's state folded from its ledger lines (spec readRooms): malformed lines are dropped, nothing
// after a terminal is folded, and "stalled" is a lookup (an opened round past its deadline with no
// close), never an inference.
export function foldRoom(lines, now = Date.now()) {
  const room = {
    id: null,
    status: 'absent',
    sittings: [],
    rounds: [],
    terminal: null,
    reason: null,
  };
  for (const l of lines || []) {
    const d = l?.kind === 'room' ? l.data : null;
    if (!d || !ROOM_EVENTS.includes(d.event) || room.terminal) continue;
    if (d.event === 'convened')
      Object.assign(room, { id: d.room, status: 'open', params: d.params });
    else if (room.status === 'absent') continue;
    else if (d.event === 'sitting') room.sittings.push(d);
    else if (d.event === 'round') {
      const r = room.rounds.find((x) => x.round === d.round);
      if (d.phase === 'opened' && !r) room.rounds.push({ ...d });
      else if (d.phase === 'closed' && r) Object.assign(r, d);
    } else if (d.event === 'ended') {
      if (!ROOM_TERMINALS.includes(d.terminal) || !String(d.reason || '').trim()) continue;
      Object.assign(room, { status: 'ended', terminal: d.terminal, reason: d.reason });
    }
  }
  if (
    room.status === 'open' &&
    room.rounds.some((r) => r.phase === 'opened' && r.deadlineAt && Date.parse(r.deadlineAt) < now)
  )
    room.status = 'stalled';
  return room;
}
