/**
 * LLM drafting and statement revision review for market creator.
 *
 * This module owns:
 * 1. The drafting prompt and response parsing for candidate markets.
 * 2. The statement revision review step: binding approved wording, deadline,
 *    and source commitment to a cryptographic SHA-256 digest.
 * 3. Pre-signing verification: rejecting signing if any reviewed statement
 *    field changed between review and on-chain submission.
 */

import * as crypto from "node:crypto";
import { extractUsdThresholds, cryptoThresholdReason } from "./thresholds.js";
import {
  canonicaliseResolutionSourceUrl,
  canonicaliseStatementDeadline,
  filterDuplicateCandidates,
  hasInvalidTextEncoding,
} from "./dedupe.js";

export interface ClaimCandidate {
  question: string;
  resolutionUrl: string;
  deadline: string;
  category?: string;
  threshold?: number;
  settlementRule?: string;
  creatorPosition?: string;
  counterPosition?: string;
  statementDigest?: string;
  sourceCommitment?: string;
  revisionReview?: StatementRevisionReview;
  [key: string]: unknown;
}

export interface DraftingContext {
  /** Source material the LLM should read from. */
  sourceText: string;
  /** Optional existing questions to avoid duplicating. */
  existingQuestions?: readonly string[];
  /** Maximum number of candidates to request. */
  maxCandidates?: number;
  /** Category hint for the prompt. */
  category?: string;
}

export type LlmCompleter = (prompt: string) => Promise<string>;

const DEFAULT_MAX_CANDIDATES = 5;

export type StatementRevisionFailureReason =
  | "invalid_wording"
  | "invalid_deadline"
  | "invalid_source"
  | "invalid_threshold"
  | "missing_review"
  | "review_rejected"
  | "invalid_digest"
  | "digest_mismatch"
  | "statement_modified";

export class StatementRevisionError extends Error {
  readonly reason: StatementRevisionFailureReason;
  readonly changedFields: string[];

  constructor(
    message: string,
    reason: StatementRevisionFailureReason = "statement_modified",
    changedFields: string[] = [],
  ) {
    super(message);
    this.name = "StatementRevisionError";
    this.reason = reason;
    this.changedFields = changedFields;
    Object.setPrototypeOf(this, StatementRevisionError.prototype);
  }
}

export interface ReviewedStatement {
  question: string;
  wording: string;
  deadline: string;
  resolutionUrl: string;
  sourceCommitment: string;
  category?: string;
  threshold?: number;
  settlementRule?: string;
  creatorPosition?: string;
  counterPosition?: string;
  statementDigest?: string;
  [key: string]: unknown;
}

export interface StatementRevisionReview {
  approved: boolean;
  digest: string;
  statementDigest: string;
  sourceCommitment: string;
  deadline: string;
  revised: boolean;
  revisedFields: string[];
  statement: ReviewedStatement;
  candidate: ClaimCandidate;
  notes?: string;
  reviewer?: string;
}

export interface StatementRevisionReviewOptions {
  sourceText?: string;
  reviewer?: string;
  approved?: boolean;
  notes?: string;
  now?: string | number | Date;
  allowedResolutionUrls?: readonly string[];
  revision?: Partial<ClaimCandidate>;
}

export interface StatementSigningVerificationResult {
  ok: boolean;
  allowed: boolean;
  reason?: StatementRevisionFailureReason;
  changedFields: string[];
  error?: string;
}

/**
 * Build a deterministic source commitment binding the canonical resolution URL
 * and the raw source text snapshot into a SHA-256 digest.
 */
export function buildSourceCommitment(params: {
  resolutionUrl: string;
  sourceText?: string;
}): string {
  const canonicalUrl = canonicaliseResolutionSourceUrl(params.resolutionUrl);
  if (!canonicalUrl) {
    throw new StatementRevisionError(
      `Invalid resolutionUrl for source commitment: "${params.resolutionUrl}"`,
      "invalid_source",
      ["resolutionUrl"],
    );
  }
  const normalizedSource = typeof params.sourceText === "string" ? params.sourceText.trim() : "";
  const payload = `url:${canonicalUrl}\nsourceText:${normalizedSource}`;
  return crypto.createHash("sha256").update(payload, "utf8").digest("hex");
}

/**
 * Generate canonical length-framed byte representation for statement fields.
 * Validates wording, encoding, and absence of control characters to prevent
 * delimiter and field-boundary forgery.
 */
export function canonicalStatementRevisionBytes(statement: {
  question?: string;
  wording?: string;
  deadline?: string | number;
  resolutionUrl?: string;
  sourceCommitment?: string;
  settlementRule?: string;
  creatorPosition?: string;
  counterPosition?: string;
  category?: string;
  threshold?: number;
}): Buffer {
  const wording =
    typeof statement.wording === "string"
      ? statement.wording
      : typeof statement.question === "string"
        ? statement.question
        : "";

  if (!wording || !wording.trim()) {
    throw new StatementRevisionError("Statement wording must not be empty", "invalid_wording", ["question"]);
  }
  if (hasInvalidTextEncoding(wording)) {
    throw new StatementRevisionError("Statement wording contains invalid text encoding", "invalid_wording", ["question"]);
  }
  if (/[\r\n\x00-\x1F\x7F]/.test(wording)) {
    throw new StatementRevisionError("Statement wording must not contain control characters or newlines", "invalid_wording", ["question"]);
  }

  if (statement.creatorPosition !== undefined && statement.counterPosition !== undefined) {
    const cp = String(statement.creatorPosition).trim().toLowerCase();
    const ctp = String(statement.counterPosition).trim().toLowerCase();
    if (cp && ctp && cp === ctp) {
      throw new StatementRevisionError("Creator position and counter position must not be identical", "invalid_wording");
    }
  }

  const deadline = canonicaliseStatementDeadline(statement.deadline);
  const resolutionUrl = canonicaliseResolutionSourceUrl(statement.resolutionUrl);
  if (!resolutionUrl) {
    throw new StatementRevisionError("Invalid resolution URL", "invalid_source", ["resolutionUrl"]);
  }

  const sourceCommitment = statement.sourceCommitment
    ? statement.sourceCommitment.trim().toLowerCase()
    : buildSourceCommitment({ resolutionUrl });

  const lines: Buffer[] = [];
  function addField(key: string, value: string | undefined) {
    if (value === undefined) return;
    const valBuf = Buffer.from(value, "utf8");
    const prefix = Buffer.from(`${key}:${valBuf.length}:`, "utf8");
    const newline = Buffer.from("\n", "utf8");
    lines.push(Buffer.concat([prefix, valBuf, newline]));
  }

  addField("wording", wording);
  addField("deadline", deadline);
  addField("resolutionUrl", resolutionUrl);
  addField("sourceCommitment", sourceCommitment);
  if (statement.settlementRule !== undefined) addField("settlementRule", String(statement.settlementRule));
  if (statement.creatorPosition !== undefined) addField("creatorPosition", String(statement.creatorPosition));
  if (statement.counterPosition !== undefined) addField("counterPosition", String(statement.counterPosition));
  if (statement.category !== undefined) addField("category", String(statement.category));
  if (statement.threshold !== undefined) addField("threshold", String(statement.threshold));

  return Buffer.concat(lines);
}

/**
 * Compute the SHA-256 digest of the canonical statement revision bytes.
 */
export function computeStatementRevisionDigest(statement: {
  question?: string;
  wording?: string;
  deadline?: string | number;
  resolutionUrl?: string;
  sourceCommitment?: string;
  settlementRule?: string;
  creatorPosition?: string;
  counterPosition?: string;
  category?: string;
  threshold?: number;
}): string {
  const bytes = canonicalStatementRevisionBytes(statement);
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

/**
 * Review a drafted market candidate statement, validate constraints, and bind
 * approved wording, deadline, and source commitment to a SHA-256 digest.
 */
export function reviewStatementRevision(
  candidate: ClaimCandidate,
  options: StatementRevisionReviewOptions = {},
): StatementRevisionReview {
  const revisedCandidate: ClaimCandidate = { ...candidate };
  const revisedFields: string[] = [];

  if (options.revision) {
    for (const [key, val] of Object.entries(options.revision)) {
      if (val !== undefined && revisedCandidate[key] !== val) {
        revisedCandidate[key] = val;
        revisedFields.push(key);
      }
    }
  }

  const wording = revisedCandidate.question;
  if (!wording || typeof wording !== "string" || !wording.trim()) {
    throw new StatementRevisionError("Statement wording must not be empty", "invalid_wording", ["question"]);
  }
  if (hasInvalidTextEncoding(wording)) {
    throw new StatementRevisionError("Statement wording contains invalid text encoding", "invalid_wording", ["question"]);
  }
  if (/[\r\n\x00-\x1F\x7F]/.test(wording)) {
    throw new StatementRevisionError("Statement wording must not contain control characters or newlines", "invalid_wording", ["question"]);
  }

  if (revisedCandidate.creatorPosition !== undefined && revisedCandidate.counterPosition !== undefined) {
    const cp = String(revisedCandidate.creatorPosition).trim().toLowerCase();
    const ctp = String(revisedCandidate.counterPosition).trim().toLowerCase();
    if (cp && ctp && cp === ctp) {
      throw new StatementRevisionError("Creator position and counter position must not be identical", "invalid_wording");
    }
  }

  const canonicalDeadline = canonicaliseStatementDeadline(revisedCandidate.deadline);
  const nowMs =
    options.now !== undefined
      ? typeof options.now === "number"
        ? options.now < 1e11
          ? options.now * 1000
          : options.now
        : new Date(options.now).getTime()
      : Date.now();
  const deadlineMs = new Date(canonicalDeadline).getTime();
  if (deadlineMs <= nowMs) {
    throw new StatementRevisionError(
      `Deadline (${canonicalDeadline}) is not strictly in the future compared to reference time (${new Date(nowMs).toISOString()})`,
      "invalid_deadline",
      ["deadline"],
    );
  }

  const canonicalUrl = canonicaliseResolutionSourceUrl(revisedCandidate.resolutionUrl);
  if (!canonicalUrl) {
    throw new StatementRevisionError(
      `Invalid resolutionUrl: "${revisedCandidate.resolutionUrl}"`,
      "invalid_source",
      ["resolutionUrl"],
    );
  }
  if (options.allowedResolutionUrls && options.allowedResolutionUrls.length > 0) {
    const canonicalAllowed = options.allowedResolutionUrls.map(
      (u) => canonicaliseResolutionSourceUrl(u) ?? u,
    );
    if (!canonicalAllowed.includes(canonicalUrl)) {
      throw new StatementRevisionError(
        `Resolution URL "${canonicalUrl}" is not in allowed list`,
        "invalid_source",
        ["resolutionUrl"],
      );
    }
  }

  if (
    revisedCandidate.threshold !== undefined &&
    (revisedCandidate.category === "crypto" || revisedCandidate.category === undefined)
  ) {
    const reason = cryptoThresholdReason(revisedCandidate.threshold);
    if (reason) {
      throw new StatementRevisionError(
        `Invalid crypto threshold ${revisedCandidate.threshold}: ${reason}`,
        "invalid_threshold",
        ["threshold"],
      );
    }
  }

  const sourceCommitment =
    revisedCandidate.sourceCommitment ??
    buildSourceCommitment({
      resolutionUrl: canonicalUrl,
      sourceText: options.sourceText,
    });

  const statement: ReviewedStatement = {
    question: wording,
    wording,
    deadline: canonicalDeadline,
    resolutionUrl: canonicalUrl,
    sourceCommitment,
    category: revisedCandidate.category,
    threshold: revisedCandidate.threshold,
    settlementRule: revisedCandidate.settlementRule,
    creatorPosition: revisedCandidate.creatorPosition,
    counterPosition: revisedCandidate.counterPosition,
  };

  const digest = computeStatementRevisionDigest(statement);
  statement.statementDigest = digest;

  const approved = options.approved !== false;

  const finalCandidate: ClaimCandidate = {
    ...revisedCandidate,
    question: wording,
    deadline: canonicalDeadline,
    resolutionUrl: canonicalUrl,
    sourceCommitment,
    statementDigest: digest,
  };

  const review: StatementRevisionReview = {
    approved,
    digest,
    statementDigest: digest,
    sourceCommitment,
    deadline: canonicalDeadline,
    revised: revisedFields.length > 0,
    revisedFields,
    statement,
    candidate: finalCandidate,
    notes: options.notes,
    reviewer: options.reviewer,
  };

  finalCandidate.revisionReview = review;
  return review;
}

/**
 * Verify that a candidate statement matches its approved review snapshot before signing.
 * Returns detailed check status and a list of any changed fields.
 */
export function verifyStatementForSigning(
  candidateOrReview: ClaimCandidate | StatementRevisionReview,
  reviewOrDigest?: StatementRevisionReview | string,
): StatementSigningVerificationResult {
  let candidate: ClaimCandidate;
  let review: StatementRevisionReview | undefined;
  let expectedDigest: string | undefined;

  if (
    "statement" in candidateOrReview &&
    "digest" in candidateOrReview &&
    typeof candidateOrReview.statement === "object"
  ) {
    // 1st argument is a StatementRevisionReview
    review = candidateOrReview as StatementRevisionReview;
    candidate = review.candidate;
    expectedDigest = review.digest;
  } else {
    // 1st argument is a ClaimCandidate
    candidate = candidateOrReview as ClaimCandidate;
    if (typeof reviewOrDigest === "string") {
      expectedDigest = reviewOrDigest;
      review = candidate.revisionReview;
    } else if (reviewOrDigest && typeof reviewOrDigest === "object" && "digest" in reviewOrDigest) {
      review = reviewOrDigest;
      expectedDigest = review.digest;
    } else if (candidate.revisionReview) {
      review = candidate.revisionReview;
      expectedDigest = review.digest;
    } else if (candidate.statementDigest) {
      expectedDigest = candidate.statementDigest;
    }
  }

  if (!review && !expectedDigest) {
    return {
      ok: false,
      allowed: false,
      reason: "missing_review",
      changedFields: [],
      error: "No statement revision review or digest found for candidate",
    };
  }

  if (review && !review.approved) {
    return {
      ok: false,
      allowed: false,
      reason: "review_rejected",
      changedFields: [],
      error: review.notes ?? "Statement review was rejected",
    };
  }

  if (expectedDigest && !/^[0-9a-f]{64}$/.test(expectedDigest)) {
    return {
      ok: false,
      allowed: false,
      reason: "invalid_digest",
      changedFields: [],
      error: `Invalid statement digest: "${expectedDigest}"`,
    };
  }

  const changedFields: string[] = [];

  if (review) {
    const s = review.statement;
    if (candidate.question !== s.question) changedFields.push("question");

    let candidateCanonicalDeadline = "";
    try {
      candidateCanonicalDeadline = canonicaliseStatementDeadline(candidate.deadline);
    } catch {
      changedFields.push("deadline");
    }
    if (candidateCanonicalDeadline && candidateCanonicalDeadline !== s.deadline) {
      changedFields.push("deadline");
    }

    let candidateCanonicalUrl: string | null = null;
    try {
      candidateCanonicalUrl = canonicaliseResolutionSourceUrl(candidate.resolutionUrl);
    } catch {
      changedFields.push("resolutionUrl");
    }
    if (candidateCanonicalUrl && candidateCanonicalUrl !== s.resolutionUrl) {
      changedFields.push("resolutionUrl");
    }

    if (
      candidate.sourceCommitment !== undefined &&
      candidate.sourceCommitment !== s.sourceCommitment
    ) {
      changedFields.push("sourceCommitment");
    }

    if (candidate.settlementRule !== s.settlementRule) changedFields.push("settlementRule");
    if (candidate.creatorPosition !== s.creatorPosition) changedFields.push("creatorPosition");
    if (candidate.counterPosition !== s.counterPosition) changedFields.push("counterPosition");
    if (candidate.category !== s.category) changedFields.push("category");
    if (candidate.threshold !== s.threshold) changedFields.push("threshold");

    if (changedFields.length > 0) {
      return {
        ok: false,
        allowed: false,
        reason: "statement_modified",
        changedFields,
        error: `Reviewed statement fields modified after approval: ${changedFields.join(", ")}`,
      };
    }
  }

  let computedDigest: string;
  try {
    computedDigest = computeStatementRevisionDigest(candidate);
  } catch (err) {
    return {
      ok: false,
      allowed: false,
      reason: "statement_modified",
      changedFields: ["statement"],
      error: err instanceof Error ? err.message : String(err),
    };
  }

  if (expectedDigest && computedDigest !== expectedDigest) {
    return {
      ok: false,
      allowed: false,
      reason: "digest_mismatch",
      changedFields: [],
      error: `Computed statement digest (${computedDigest}) does not match approved digest (${expectedDigest})`,
    };
  }

  return {
    ok: true,
    allowed: true,
    changedFields: [],
  };
}

/**
 * Assert that a statement candidate is approved and verified for signing.
 * Throws StatementRevisionError if any check fails.
 */
export function assertStatementApprovedForSigning(
  candidate: ClaimCandidate,
  reviewOrDigest?: StatementRevisionReview | string,
): void {
  const result = verifyStatementForSigning(candidate, reviewOrDigest);
  if (!result.ok) {
    throw new StatementRevisionError(
      result.error ?? "Statement not approved for signing",
      result.reason ?? "statement_modified",
      result.changedFields,
    );
  }
}

/**
 * Sign an approved candidate after verifying statement integrity.
 * Invokes the provided signer callback with the verified candidate and metadata.
 */
export async function signApprovedCandidate<T>(
  candidate: ClaimCandidate,
  review: StatementRevisionReview,
  signer: (
    approved: ClaimCandidate,
    meta: { digest: string },
  ) => Promise<T> | T,
): Promise<T> {
  assertStatementApprovedForSigning(candidate, review);
  return signer(review.candidate, { digest: review.digest });
}

/**
 * Build the review prompt for LLM statement revision review.
 */
export function buildRevisionReviewPrompt(
  candidates: readonly ClaimCandidate[],
  context: { sourceText: string; category?: string },
): string {
  const categoryLine = context.category ? `Category: ${context.category}\n` : "";
  return [
    "You are reviewing drafted prediction market statements before on-chain creation.",
    "Verify each candidate against the source material. You may approve, reject, or tighten phrasing, deadline, or threshold.",
    categoryLine,
    "Source material:",
    context.sourceText,
    "Candidates to review:",
    JSON.stringify(candidates, null, 2),
    "Return a JSON array of objects with fields: approved (boolean), question, resolutionUrl, deadline, category, threshold, notes.",
  ].filter(Boolean).join("\n\n");
}

/**
 * Parse an LLM revision review response into per-candidate decisions.
 */
export function parseRevisionReviewResponse(
  raw: string,
  drafted: readonly ClaimCandidate[],
): Array<Partial<ClaimCandidate> & { approved: boolean; notes?: string }> {
  if (!raw) return [];
  const trimmed = raw.trim();
  const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*)```/i);
  const jsonText = fenceMatch ? fenceMatch[1] : trimmed;

  const start = jsonText.indexOf("[");
  const end = jsonText.lastIndexOf("]");
  if (start < 0 || end <= start) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText.slice(start, end + 1));
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  const out: Array<Partial<ClaimCandidate> & { approved: boolean; notes?: string }> = [];
  for (let i = 0; i < parsed.length; i++) {
    const item = parsed[i];
    if (!item || typeof item !== "object") continue;
    const rec = item as Record<string, unknown>;
    const approved = rec.approved !== false;
    out.push({
      approved,
      notes: typeof rec.notes === "string" ? rec.notes : undefined,
      question: typeof rec.question === "string" ? rec.question : drafted[i]?.question,
      resolutionUrl: typeof rec.resolutionUrl === "string" ? rec.resolutionUrl : drafted[i]?.resolutionUrl,
      deadline: typeof rec.deadline === "string" ? rec.deadline : drafted[i]?.deadline,
      category: typeof rec.category === "string" ? rec.category : drafted[i]?.category,
      threshold: typeof rec.threshold === "number" ? rec.threshold : drafted[i]?.threshold,
      settlementRule: typeof rec.settlementRule === "string" ? rec.settlementRule : drafted[i]?.settlementRule,
      creatorPosition: typeof rec.creatorPosition === "string" ? rec.creatorPosition : drafted[i]?.creatorPosition,
      counterPosition: typeof rec.counterPosition === "string" ? rec.counterPosition : drafted[i]?.counterPosition,
    });
  }
  return out;
}

/**
 * Review a batch of drafted candidates, apply revisions, bind cryptographic digests,
 * and filter out duplicates resulting from revised statements.
 */
export async function reviewDraftedCandidates(
  candidates: readonly ClaimCandidate[],
  options: {
    sourceText?: string;
    reviewer?: (
      candidate: ClaimCandidate,
      index: number,
    ) =>
      | (Partial<ClaimCandidate> & { approved?: boolean; notes?: string })
      | Promise<Partial<ClaimCandidate> & { approved?: boolean; notes?: string }>;
    completer?: LlmCompleter;
    category?: string;
    allowedResolutionUrls?: readonly string[];
  } = {},
): Promise<ClaimCandidate[]> {
  let decisions: Array<Partial<ClaimCandidate> & { approved?: boolean; notes?: string }> | null = null;

  if (options.completer) {
    const prompt = buildRevisionReviewPrompt(candidates, {
      sourceText: options.sourceText ?? "",
      category: options.category,
    });
    const raw = await options.completer(prompt);
    decisions = parseRevisionReviewResponse(raw, candidates);
  }

  const approvedList: ClaimCandidate[] = [];

  for (let i = 0; i < candidates.length; i++) {
    const candidate = candidates[i]!;
    let revision: (Partial<ClaimCandidate> & { approved?: boolean; notes?: string }) | undefined;

    if (options.reviewer) {
      revision = await options.reviewer(candidate, i);
    } else if (decisions && decisions[i]) {
      revision = decisions[i];
    }

    if (revision && revision.approved === false) {
      continue;
    }

    try {
      const revisionPayload: Partial<ClaimCandidate> = {};
      if (revision) {
        if (revision.question !== undefined) revisionPayload.question = revision.question;
        if (revision.resolutionUrl !== undefined) revisionPayload.resolutionUrl = revision.resolutionUrl;
        if (revision.deadline !== undefined) revisionPayload.deadline = revision.deadline;
        if (revision.category !== undefined) revisionPayload.category = revision.category;
        if (revision.threshold !== undefined) revisionPayload.threshold = revision.threshold;
        if (revision.settlementRule !== undefined) revisionPayload.settlementRule = revision.settlementRule;
        if (revision.creatorPosition !== undefined) revisionPayload.creatorPosition = revision.creatorPosition;
        if (revision.counterPosition !== undefined) revisionPayload.counterPosition = revision.counterPosition;
      }

      const review = reviewStatementRevision(candidate, {
        sourceText: options.sourceText,
        allowedResolutionUrls: options.allowedResolutionUrls,
        notes: revision?.notes,
        revision: Object.keys(revisionPayload).length > 0 ? revisionPayload : undefined,
      });

      if (review.approved) {
        approvedList.push(review.candidate);
      }
    } catch {
      // Drop candidates failing revision review constraints
    }
  }

  // Deduplicate against post-revision signatures
  return filterDuplicateCandidates(approvedList);
}

// ── Existing LLM candidate drafting and filtering ──────────────────────────────

export function buildDraftingPrompt(context: DraftingContext): string {
  const max = context.maxCandidates ?? DEFAULT_MAX_CANDIDATES;
  const categoryLine = context.category ? `Category: ${context.category}\n` : "";
  const existingLine = context.existingQuestions?.length
    ? `Existing questions (do not duplicate):\n${context.existingQuestions.map((q) => `- ${q}`).join("\n")}\n`
    : "";

  return [
    "You are drafting prediction market candidates.",
    "Each candidate must be settleable by fetching ONE resolutionUrl and reading a number or a date out of it.",
    categoryLine,
    existingLine,
    `Return at most ${max} candidates as a JSON array of objects with fields: question, resolutionUrl, deadline (ISO 8601), category, threshold (optional, USD).`,
    "Source material:",
    context.sourceText,
  ].filter(Boolean).join("\n\n");
}

/**
 * Parse the LLM response into candidates. Tolerates code fences and
 * surrounding prose. Returns [] on any parsing failure - the caller treats
 * that as "no candidates this run".
 */
export function parseDraftedCandidates(raw: string): ClaimCandidate[] {
  if (!raw) return [];
  const trimmed = raw.trim();
  const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*)```/i);
  const jsonText = fenceMatch ? fenceMatch[1] : trimmed;

  const start = jsonText.indexOf("[");
  const end = jsonText.lastIndexOf("]");
  if (start < 0 || end <= start) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText.slice(start, end + 1));
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  const out: ClaimCandidate[] = [];
  for (const item of parsed) {
    if (!item || typeof item !== "object") continue;
    const rec = item as Record<string, unknown>;
    const question = typeof rec.question === "string" ? rec.question.trim() : "";
    const resolutionUrl = typeof rec.resolutionUrl === "string" ? rec.resolutionUrl.trim() : "";
    const deadline = typeof rec.deadline === "string" ? rec.deadline.trim() : "";
    if (!question || !resolutionUrl || !deadline) continue;
    out.push({
      question,
      resolutionUrl,
      deadline,
      category: typeof rec.category === "string" ? rec.category : undefined,
      threshold: typeof rec.threshold === "number" ? rec.threshold : undefined,
    });
  }
  return out;
}

/**
 * Drop candidates whose crypto threshold fails the sanity check.
 * Candidates without a threshold are kept unchanged.
 */
export function filterUnsafeCryptoThresholds(
  candidates: readonly ClaimCandidate[],
): ClaimCandidate[] {
  return candidates.filter((candidate) => {
    if (candidate.threshold === undefined) return true;
    return cryptoThresholdReason(candidate.threshold) === null;
  });
}

/**
 * Draft candidates by calling the provided completer with the drafting
 * prompt, then parsing and sanitising the response.
 */
export async function draftClaimCandidates(
  completer: LlmCompleter,
  context: DraftingContext,
): Promise<ClaimCandidate[]> {
  const prompt = buildDraftingPrompt(context);
  const raw = await completer(prompt);
  const parsed = parseDraftedCandidates(raw);
  return filterUnsafeCryptoThresholds(parsed);
}

export { extractUsdThresholds, cryptoThresholdReason };
