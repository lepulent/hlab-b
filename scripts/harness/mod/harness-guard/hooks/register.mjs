// Step 18: the seat guard as a mod, the second adapter of the seat policy (seat-policy.mjs, copied beside
// this file by install-bundle.sh and kept by harness-in-sync). Loaded per seat with
// `claude -p --plugin-dir <a staged copy>`; the orchestrator stages that copy outside every seat-writable
// path and writes hooks/seat.json into it: { root, departments, reach, forceThrow }.
//
//   tool.call        every call is ruled by seatRuling before it runs; a deny answers the call with the
//                    ruling's message, and the attempt is witnessed; a call that ran is witnessed after
//   plugin.register  no other plugin's hooks join a seat (one could answer tool.call above this guard,
//                    and a seat can plant one under .claude/skills/<name>)
//
// It FAILS CLOSED: each gate's .catch refuses when the hook failed before it called next, so a guard that
// throws (or is made to, by seat.json forceThrow, the lab lever) denies. It calls only fs.read, fs.write
// and session.id: no model, network, process or agent call (the mod-reach check).
import { seatRuling, deniedLine, footprintLine } from './seat-policy.mjs';

let config = null;
const seat = async ($) => {
  config ??= JSON.parse(await $.fs.read(`${$.plugin.root}/hooks/seat.json`));
  return config;
};
// the witness, appended in order: one environment per session, so a chain serialises the writes
let chain = Promise.resolve();
const witness = ($, cfg, line) => {
  chain = chain.then(async () => {
    const file = `${cfg.root}/.harness/footprint/${await $.session.id()}.jsonl`;
    const before = await $.fs.read(file).catch(() => '');
    await $.fs.write(
      file,
      `${before}${JSON.stringify({ ts: new Date().toISOString(), ...line })}\n`,
    );
  });
  return chain.catch(() => undefined);
};

export const register = (on) => {
  on('tool.call', async ($, e, next) => {
    const cfg = await seat($);
    if (cfg.forceThrow) throw new Error('forced by seat.json forceThrow');
    // the tool's own arguments are spread beside the envelope's reserved keys
    const RESERVED = ['tool', 'tool_use_id', 'agentId', 'consent'];
    const tool = e.tool;
    const input = Object.fromEntries(Object.entries(e).filter(([k]) => !RESERVED.includes(k)));
    const ruling = seatRuling({
      tool,
      input,
      cwd: await $.session.cwd(),
      root: cfg.root,
      departments: cfg.departments,
      reach: cfg.reach || null,
    });
    if (!ruling.allow) {
      await witness($, cfg, deniedLine(tool, input, cfg.root, ruling));
      return { deny: ruling.message || `Denied: ${ruling.reason}` };
    }
    const ran = await next(e);
    await witness($, cfg, footprintLine(tool, input, cfg.root));
    return ran;
  }).catch(async ($, e, next) => {
    if (next.called) return next(e);
    // the deny stands, and the attempt is witnessed: under the seat's root when its config was read,
    // else under the session's cwd (a conducted seat's cwd is the app root; a room seat's is its own
    // folder, where the witness trips the room's tripwire, which ends it blocked: closed either way)
    try {
      const root = config?.root ?? (await $.session.cwd());
      await witness(
        $,
        { root },
        {
          ...footprintLine(e.tool, {}, root),
          denied: 'guard-failed',
          reason: 'the seat guard could not rule',
        },
      );
    } catch {
      /* the deny stands even when it cannot be witnessed */
    }
    return { deny: 'harness-guard: the seat guard could not rule, so the call is denied' };
  });

  // what it refused is witnessed, so the mods-admitted check can tell a refused plugin from a loaded one
  // (the session's init lists every plugin it read, refused or not)
  on('plugin.register', async ($, e, next) => {
    if (e.root === $.plugin.root) return next(e);
    const cfg = await seat($);
    await witness($, cfg, {
      tool: 'plugin.register',
      target: e.root,
      denied: 'harness-guard',
      reason: e.provenance,
    });
    return {
      refuse: `harness-guard admits no other plugin into a seat: ${e.name} (${e.provenance})`,
    };
  }).catch(() => ({ refuse: 'harness-guard: the plugin guard failed, so the plugin is refused' }));
};
