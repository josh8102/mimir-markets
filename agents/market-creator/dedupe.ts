/**
 * Dedupe helpers for market-creator candidates.
 *
 * Two candidates are considered duplicates when they share the same
 * (question, resolutionUrl, deadline) signature. The signature is normalised
 * so that case, punctuation and whitespace differences don't produce duplicates
 * on-chain.
 */

import { StatementRevisionError } from "./drafting.js";

export interface CandidateLike {
  question?: string;
  resolutionUrl?: string;
  deadline?: string | number;
  statementDigest?: string;
  sourceCommitment?: string;
  // Optional canonical fields that may be present on candidates.
  id?: string;
  title?: string;
  [key: string]: unknown;
}

export function normaliseQuestion(question: string | undefined): string {
  if (!question) return "";
  return question
    .toLowerCase()
    .replace(/[^a-z0-9]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function normaliseUrl(url: string | undefined): string {
  if (!url) return "";
  return url.trim().replace(/\/+$/, "").toLowerCase();
}

export function normaliseDeadline(deadline: string | number | undefined): string {
  if (deadline === undefined || deadline === null || deadline === "") return "";
  try {
    return canonicaliseStatementDeadline(deadline);
  } catch {
    return String(deadline).trim().toLowerCase();
  }
}

export const normalizeComparableText = normaliseQuestion;
export const normalizeResolutionUrl = normaliseUrl;
export const normalizeDeadline = normaliseDeadline;

export interface ExistingClaimSignature {
  id?: number | string;
  category?: string;
  questionKey?: string;
  sourceKey?: string;
  [key: string]: unknown;
}

/**
 * Normalise a statement deadline to canonical ISO-8601 UTC representation (e.g. "2026-11-22T12:00:00.000Z").
 * Accepts ISO-8601 strings, unix timestamps (in seconds or milliseconds), or numeric strings.
 */
export function canonicaliseStatementDeadline(deadline: unknown): string {
  if (deadline === undefined || deadline === null || deadline === "") {
    throw new StatementRevisionError("Missing deadline timestamp", "invalid_deadline", ["deadline"]);
  }

  let ms: number;
  if (typeof deadline === "number") {
    if (!Number.isFinite(deadline) || Number.isNaN(deadline)) {
      throw new StatementRevisionError("Invalid numeric deadline", "invalid_deadline", ["deadline"]);
    }
    // If < 1e11, treat as unix seconds; otherwise milliseconds
    ms = deadline < 1e11 ? Math.floor(deadline * 1000) : Math.floor(deadline);
  } else if (typeof deadline === "string") {
    const trimmed = deadline.trim();
    if (!trimmed) {
      throw new StatementRevisionError("Empty deadline timestamp", "invalid_deadline", ["deadline"]);
    }
    // Check if entire string is numeric (unix seconds or milliseconds)
    if (/^-?\d+(\.\d+)?$/.test(trimmed)) {
      const num = Number(trimmed);
      if (!Number.isFinite(num)) {
        throw new StatementRevisionError("Invalid numeric deadline string", "invalid_deadline", ["deadline"]);
      }
      ms = num < 1e11 ? Math.floor(num * 1000) : Math.floor(num);
    } else {
      ms = Date.parse(trimmed);
    }
  } else if (deadline instanceof Date) {
    ms = deadline.getTime();
  } else {
    throw new StatementRevisionError("Unsupported deadline type", "invalid_deadline", ["deadline"]);
  }

  if (!Number.isFinite(ms) || Number.isNaN(ms)) {
    throw new StatementRevisionError(`Invalid deadline timestamp: ${String(deadline)}`, "invalid_deadline", ["deadline"]);
  }

  return new Date(ms).toISOString();
}

/**
 * Validate and canonicalise a resolution source URL.
 * Requires http or https protocol and returns normalized URL href (without trailing slash on pathname).
 * Returns null if URL is malformed, empty, or not http(s).
 */
export function canonicaliseResolutionSourceUrl(url: unknown): string | null {
  if (typeof url !== "string") return null;
  const trimmed = url.trim();
  if (!trimmed) return null;

  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return null;
    }
    const origin = parsed.origin.toLowerCase();
    let pathname = parsed.pathname.replace(/\/+$/, "");
    if (pathname === "" && !parsed.search && !parsed.hash) {
      pathname = "";
    }
    const search = parsed.search;
    return `${origin}${pathname}${search}`;
  } catch {
    return null;
  }
}

/**
 * Check whether a string contains invalid UTF-16 text encoding (such as unpaired surrogates).
 */
export function hasInvalidTextEncoding(text: string): boolean {
  try {
    encodeURIComponent(text);
    return false;
  } catch {
    return true;
  }
}

/**
 * Build a stable signature for a candidate. Used to detect duplicates
 * across the same run and against already-created markets.
 */
export function buildCandidateSignature(candidate: CandidateLike): string {
  const question = normaliseQuestion(candidate.question ?? candidate.title);
  const url = normaliseUrl(candidate.resolutionUrl);
  const deadline = normaliseDeadline(candidate.deadline);
  return `${question}|${url}|${deadline}`;
}

/**
 * Filter duplicate candidates while preserving input order.
 *
 * The first occurrence of a signature wins; subsequent ones are dropped.
 * An optional `seen` set can be passed in to also dedupe against candidates
 * that already exist on-chain or in a previous batch.
 */
export function filterDuplicateCandidates<T extends CandidateLike>(
  candidates: readonly T[],
  seen: Set<string> = new Set(),
): T[] {
  const out: T[] = [];
  for (const candidate of candidates) {
    const sig = buildCandidateSignature(candidate);
    if (seen.has(sig)) continue;
    seen.add(sig);
    out.push(candidate);
  }
  return out;
}

export {
  assertStatementApprovedForSigning,
  buildRevisionReviewPrompt,
  buildSourceCommitment,
  canonicalStatementRevisionBytes,
  computeStatementRevisionDigest,
  parseRevisionReviewResponse,
  reviewDraftedCandidates,
  reviewStatementRevision,
  signApprovedCandidate,
  verifyStatementForSigning,
  StatementRevisionError,
  type ClaimCandidate,
  type ReviewedStatement,
  type StatementRevisionReview,
  type StatementSigningVerificationResult,
} from "./drafting.js";
