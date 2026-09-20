import { existsSync } from "node:fs";
import { STATUS, readState, statePath } from "./state.mjs";

/** A work id may never take one of these, or `work/dna/` would shadow the command (D79). */
export const RESERVED = Object.freeze(["init", "doctor", "dna"]);

const TICKET_REF = /^(?:\d+|[A-Z][A-Z0-9]*-\d+)$/;
const SLUG_WORDS = 6;
const SLUG_MIN_WORDS = 4;

/** Stopwords only; if stripping them leaves too little, the unfiltered words stand. */
const FILLER = new Set([
  "a", "an", "and", "are", "at", "be", "do", "does", "for", "from", "in", "is",
  "it", "of", "on", "or", "that", "the", "this", "to", "with",
]);

export class ResolveError extends Error {}

export function isUrl(arg) {
  return /^https?:\/\//i.test(arg);
}

export function looksLikeTicketRef(arg) {
  return TICKET_REF.test(arg);
}

function words(text) {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().split(" ").filter(Boolean);
}

export function slugify(text) {
  const all = words(text);
  const meaningful = all.filter((word) => !FILLER.has(word));
  const chosen = meaningful.length >= SLUG_MIN_WORDS ? meaningful : all;
  return chosen.slice(0, SLUG_WORDS).join("-");
}

export function datePrefix(now) {
  return now.toISOString().slice(0, 10).replace(/-/g, "");
}

/**
 * D51: a tracker ref is used exactly as the tracker writes it; a sentence becomes the
 * date plus a slug. The module prefix appears only when two modules could both own
 * issue 42, which is the one case D38's "no module prefix" rule did not foresee.
 */
export function mintId({ text, now = new Date(), modulePrefix = null }) {
  const bare = looksLikeTicketRef(text) ? text : `${datePrefix(now)}-${slugify(text)}`;
  return modulePrefix ? `${modulePrefix}-${bare}` : bare;
}

export function ticketOwningModules(config) {
  return config?.repo?.kind === "multi" ? (config.repo.tickets ?? []) : [];
}

export function modulePrefixFor(config) {
  const owners = ticketOwningModules(config);
  return owners.length > 1 ? owners[0] : null;
}

/**
 * D24: `in_progress` resumes, but the recorded position only triggers a cheap
 * preflight — checked boxes alone are not trusted (D67d).
 */
export function resumeAction(state) {
  if (state.status === STATUS.halted) return { action: "present_halt", stage: state.stage };
  if (state.status === STATUS.reviewed) return { action: "ship" };
  if (state.status === STATUS.shipped) return { action: "next_pass", confirm: true, pass: state.pass + 1 };
  return { action: "resume", stage: state.stage, step: state.step, preflight: true };
}

function existingWork(root, id) {
  if (!existsSync(statePath(root, id))) return null;
  try {
    return readState(root, id);
  } catch {
    throw new ResolveError(
      `work/${id}/state.json exists but cannot be read. kiln will not reuse the directory — inspect ${statePath(root, id)} or choose another id.`,
    );
  }
}

function resumeOrRefuse(root, id) {
  const state = existingWork(root, id);
  if (!state) return null;
  if (state.id !== id) {
    throw new ResolveError(`work/${id}/ records work "${state.id}". kiln never reuses another work's directory.`);
  }
  return { kind: "work", id, state, ...resumeAction(state) };
}

export function trackerConfigured(config) {
  const provider = config?.tracker?.provider;
  return Boolean(provider) && provider !== "none";
}

function newIdFor(arg, options) {
  return mintId({ text: arg, now: options.now, modulePrefix: modulePrefixFor(options.config) });
}

/**
 * Resolution order, most specific first (D24), with reserved words ahead of all of it
 * so a work directory can never shadow a command.
 */
export function resolveArgument({ arg, root, config = {}, now = new Date() }) {
  if (!arg) return { kind: "list" };
  if (RESERVED.includes(arg)) return { kind: "reserved", command: arg };
  if (isUrl(arg)) return { kind: "url", url: arg, action: "fetch" };

  const resumed = resumeOrRefuse(root, arg);
  if (resumed) return resumed;

  const id = newIdFor(arg, { config, now });
  if (looksLikeTicketRef(arg) && trackerConfigured(config)) return { kind: "ticket", ref: arg, id, action: "fetch" };
  return { kind: "description", text: arg, id, action: "investigate" };
}
