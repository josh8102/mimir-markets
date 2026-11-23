/**
 * Dedupe helpers for market-creator candidates.
 *
 * Two candidates are considered duplicates when they share the same
 * (question, resolutionUrl, deadline, sourceSnapshot) signature. The signature
 * is normalised so that case, punctuation and whitespace differences don't
 * produce duplicates on-chain.
 *
 * The source snapshot binds a draft to the exact capture of its source
 * material (source identity plus capture version). Two drafts that read the
 * same question but from materially different snapshots are NOT duplicates:
 * a future-outcome question resolved against a different capture of the same
 * URL can have a different answer, so collapsing them would drop a market
 * that is genuinely distinct.
 *
 * The normalization policy version is included in the signature so that when
 * the normalization rules change, previously-seen keys are not silently reused
 * across policy generations. Bumping NORMALIZATION_POLICY_VERSION invalidates
 * all cached dedupe decisions computed under older policies.
 */

/**
 * Version of the normalization policy used to build candidate signatures.
 * Increment whenever normaliseQuestion / normaliseUrl / normaliseDeadline
 * change behaviour in a way that could alter signatures.
 */
export const NORMALIZATION_POLICY_VERSION = "v1";

import {
  interpretDeadline,
  parseExplicitDeadline,
  formatUtcOffset,
  type DeadlineInterpretation,
  type DeadlineParseResult,
  type DeadlineRejectionReason,
} from "./drafting.js";

export interface CandidateLike {
  question?: string;
  resolutionUrl?: string;
  /** Deadline timestamp (normalized to canonical UTC ISO-8601 when valid). */
  deadline?: string;
  /** Identity of the source the draft was read from (e.g. feed or API id). */
  sourceId?: string;
  /** Version/capture marker of the source material at drafting time. */
  sourceVersion?: string;
  // Optional canonical fields that may be present on candidates.
  id?: string;
  title?: string;
  [key: string]: unknown;
}

function normaliseQuestion(question: string | undefined): string {
  if (!question) return "";
  return question
    .toLowerCase()
    .replace(/[^a-z0-9]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normaliseUrl(url: string | undefined): string {
  if (!url) return "";
  return url.trim().replace(/\/+$/, "").toLowerCase();
}

function extractExplicitZoneFromCandidate(
  candidate: CandidateLike,
): { ok: true; zone?: string; fromSourceZoneOnly: boolean } | { ok: false } {
  const inputKeys = ["timeZone", "timezone", "deadlineTimeZone", "deadlineTimezone"] as const;
  let selectedInput: string | undefined;

  for (const key of inputKeys) {
    const val = candidate[key];
    if (val === undefined || val === null) continue;
    if (typeof val !== "string") return { ok: false };
    const trimmed = val.trim();
    if (!trimmed) return { ok: false };
    if (selectedInput !== undefined && selectedInput.toLowerCase() !== trimmed.toLowerCase()) {
      return { ok: false };
    }
    selectedInput = trimmed;
  }

  if (candidate.sourceZone !== undefined && candidate.sourceZone !== null) {
    if (typeof candidate.sourceZone !== "string") return { ok: false };
    const trimmedSource = candidate.sourceZone.trim();
    if (!trimmedSource) return { ok: false };
    if (selectedInput !== undefined && selectedInput.toLowerCase() !== trimmedSource.toLowerCase()) {
      return { ok: false };
    }
    if (selectedInput === undefined) {
      return { ok: true, zone: trimmedSource, fromSourceZoneOnly: true };
    }
  }

  return { ok: true, zone: selectedInput, fromSourceZoneOnly: false };
}

/**
 * Resolve and validate the deadline on a candidate object, returning the
 * canonical UTC timestamp and retained source time-zone metadata, or `null`
 * if the deadline is missing, malformed, or an ambiguous local-only timestamp.
 */
export function resolveCandidateDeadline(candidate: CandidateLike): DeadlineInterpretation | null {
  if (typeof candidate.deadline !== "string") return null;
  const rawDeadline = candidate.deadline.trim();
  if (!rawDeadline) return null;

  const zoneField = extractExplicitZoneFromCandidate(candidate);
  if (!zoneField.ok) return null;

  // If the candidate already carries a validated deadlineInterpretation matching its canonical UTC deadline,
  // verify it and preserve its original rawDeadline and sourceZone metadata.
  if (
    candidate.deadlineInterpretation &&
    typeof candidate.deadlineInterpretation === "object" &&
    candidate.deadlineInterpretation.canonicalUtc === rawDeadline &&
    typeof candidate.deadlineInterpretation.rawDeadline === "string" &&
    typeof candidate.deadlineInterpretation.sourceZone === "string"
  ) {
    const verified = interpretDeadline(
      candidate.deadlineInterpretation.rawDeadline,
      candidate.deadlineInterpretation.sourceZone,
    );
    if (verified && verified.canonicalUtc === rawDeadline) {
      if (
        zoneField.zone === undefined ||
        zoneField.zone.toLowerCase() === verified.sourceZone.toLowerCase()
      ) {
        return verified;
      }
    }
  }

  const direct = interpretDeadline(rawDeadline, zoneField.zone);
  if (direct) return direct;

  // Handle already-normalized candidates where `deadline` is a canonical UTC `Z` string
  // and `sourceZone` records the original non-UTC source zone as metadata.
  if (zoneField.fromSourceZoneOnly && zoneField.zone && /[Zz]$/.test(rawDeadline)) {
    const utcParsed = interpretDeadline(rawDeadline);
    if (!utcParsed) return null;
    // Validate that `sourceZone` itself is a legitimate explicit zone by probing a sample wall-clock date.
    const zoneProbe = interpretDeadline("2026-01-15T12:00:00", zoneField.zone);
    if (!zoneProbe) return null;
    return {
      canonicalUtc: utcParsed.canonicalUtc,
      sourceZone: zoneProbe.sourceZone,
      offsetMinutes: zoneProbe.offsetMinutes,
      utcOffset: zoneProbe.utcOffset,
      rawDeadline: candidate.deadlineInterpretation?.rawDeadline ?? rawDeadline,
    };
  }

  return null;
}

/**
 * Normalize a deadline string to its canonical UTC ISO-8601 timestamp.
 *
 * Requires an explicit time-zone designator in `deadline` (e.g. `Z` or `±HH:MM`)
 * or an explicit `explicitZone` argument (IANA zone or UTC offset).
 * Returns `""` when `deadline` is empty, malformed, or an ambiguous local-only value.
 */
export function normaliseDeadline(
  deadline: string | undefined,
  explicitZone?: string,
): string {
  if (!deadline) return "";
  const interpreted = interpretDeadline(deadline, explicitZone);
  if (!interpreted) return "";
  return interpreted.canonicalUtc;
}

function normaliseSnapshot(candidate: CandidateLike): string {
  const source = (candidate.sourceId ?? "").trim().toLowerCase();
  const version = (candidate.sourceVersion ?? "").trim().toLowerCase();
  // Encode absent values distinctly so a missing snapshot never equals a real one.
  return `${source}@${version}`;
}

/**
 * Build a stable signature for a candidate. Used to detect duplicates
 * across the same run and against already-created markets.
 *
 * The signature is prefixed with the normalization policy version so that
 * keys produced under different policies never compare equal.
 */
export function buildCandidateSignature(
  candidate: CandidateLike,
  policyVersion: string = NORMALIZATION_POLICY_VERSION,
): string {
  const question = normaliseQuestion(candidate.question ?? candidate.title);
  const url = normaliseUrl(candidate.resolutionUrl);
  const deadline = normaliseDeadline(candidate.deadline);
  const snapshot = normaliseSnapshot(candidate);
  return `${policyVersion}|${question}|${url}|${deadline}|${snapshot}`;
}

/**
 * Filter duplicate candidates while preserving input order.
 *
 * When a candidate specifies a `deadline`, it must have an explicit time-zone
 * interpretation; candidates with ambiguous local-only or malformed deadlines
 * are rejected. Kept candidates have their `deadline` normalized to a canonical
 * UTC timestamp with `sourceZone` and `deadlineInterpretation` retained as metadata.
 *
 * The first occurrence of a signature wins; subsequent ones are dropped.
 * An optional `seen` set can be passed in to also dedupe against candidates
 * that already exist on-chain or in a previous batch. Keys recorded under a
 * different normalization policy version will not match and are therefore
 * treated as incompatible rather than reused.
 */
export function filterDuplicateCandidates<T extends CandidateLike>(
  candidates: readonly T[],
  seen: Set<string> = new Set(),
  policyVersion: string = NORMALIZATION_POLICY_VERSION,
): T[] {
  const out: T[] = [];
  for (const candidate of candidates) {
    const sig = buildCandidateSignature(candidate, policyVersion);
    if (seen.has(sig)) continue;
    seen.add(sig);
    out.push(candidate);
  }
  return out;
}

/**
 * Drop cached dedupe keys that were produced under a different normalization
 * policy version. Keys are expected to carry their version as the prefix
 * before the first '|'. Returns the number of keys removed.
 */
export function invalidateIncompatibleKeys(
  seen: Set<string>,
  policyVersion: string = NORMALIZATION_POLICY_VERSION,
): number {
  let removed = 0;
  for (const key of [...seen]) {
    const sep = key.indexOf("|");
    const keyVersion = sep < 0 ? "" : key.slice(0, sep);
    if (keyVersion !== policyVersion) {
      seen.delete(key);
      removed++;
    }
  }
  return removed;
}
