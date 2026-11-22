/**
 * LLM drafting for market creator.
 *
 * This module owns the prompt and the parsing of the model's response
 * into candidate objects. The prompts and caps are deliberately unchanged by the
 * refactor - this is a move, not a rewrite.
 */

import { extractUsdThresholds, cryptoThresholdReason } from "./thresholds.js";
import { buildCandidateSignature } from "./dedupe.js";
import {
  bumpCategoryUsage,
  checkCategoryCreatorCap,
  normalizeCategory,
  type CategoryCapPolicy,
  type CategoryExposureBucket,
} from "../../lib/market-creator/category-caps.js";
import { checkCreatorExposureCap } from "../../lib/market-creator/exposure-caps.js";
import type { CreatorDecisionCode } from "../../lib/market-creator/mode-matrix.js";

export type { CreatorDecisionCode };

export interface ClaimCandidate {
  question: string;
  resolutionUrl: string;
  deadline: string;
  category?: string;
  threshold?: number;
  qualityScore?: number;
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

/**
 * Exported for tests and for callers that want to inspect threshold
 * mentions in a drafted question without running the full filter.
 */
export { extractUsdThresholds, cryptoThresholdReason };

// ── Creator decision reporting ────────────────────────────────────────────────

export interface CreatorCandidateDecision {
  candidate: ClaimCandidate;
  accepted: boolean;
  decisionCode: CreatorDecisionCode;
  reason?: string;
  category?: string;
  /** Set when `decisionCode === "category_budget_exhausted"`. */
  limitedBy?: "markets" | "exposure";
  openExposureUsdc?: number;
  nextExposureUsdc?: number;
}

export interface CreatorRunReport {
  accepted: ClaimCandidate[];
  rejected: CreatorCandidateDecision[];
  decisions: CreatorCandidateDecision[];
  countsByDecisionCode: Partial<Record<CreatorDecisionCode, number>>;
  summary: {
    total: number;
    accepted: number;
    rejected: number;
    sourceQualityRejected: number;
    categoryBudgetExhausted: number;
    exposureCapExceeded: number;
    duplicateRejected: number;
  };
  openExposureUsdc: number;
  remainingExposureUsdc: number;
  categoryUsage: Record<string, CategoryExposureBucket>;
}

export interface EvaluateCreatorCandidatesOptions {
  /** Stake posted per market in display USDC. */
  stakeUsdc: number;
  /** Creator's current open exposure in display USDC before this batch. */
  openExposureUsdc: number;
  /** Hard ceiling on total open creator exposure in display USDC. */
  maxOpenExposureUsdc: number;
  /** Per-category open-market and USDC exposure cap policy. */
  categoryCaps: CategoryCapPolicy;
  /** Current open inventory per normalised category. */
  byCategory?: Record<string, CategoryExposureBucket>;
  /** Optional minimum quality score (0-100); candidates below this fail source quality. */
  minQualityScore?: number;
  /** Optional allowlist of resolution URLs; candidates outside it fail source quality. */
  allowedResolutionUrls?: ReadonlySet<string> | readonly string[];
  /** Optional existing candidate signatures to dedupe against. */
  seenSignatures?: ReadonlySet<string>;
  /** Optional operational kill-switch check per category. */
  isCategoryEnabled?: (category: string | undefined) => boolean;
}

function normaliseUrlForAllowlist(url: string): string {
  return url.trim().replace(/\/+$/, "").toLowerCase();
}

/**
 * Evaluate drafted candidates and build a structured creator report with
 * distinct decision codes separating category budget exhaustion from
 * source-quality rejection, duplicate detection, and global USDC exposure caps.
 *
 * Preserves exact USDC exposure checks via `checkCreatorExposureCap` and
 * `checkCategoryCreatorCap`, updating local accounting optimistically after
 * each accepted candidate.
 */
export function evaluateCreatorCandidates(
  candidates: readonly ClaimCandidate[],
  options: EvaluateCreatorCandidatesOptions,
): CreatorRunReport {
  const seen = new Set<string>(options.seenSignatures ?? []);
  const allowedUrls = options.allowedResolutionUrls
    ? new Set(
        Array.from(options.allowedResolutionUrls, (url) => normaliseUrlForAllowlist(url)),
      )
    : null;

  const categoryUsage: Record<string, CategoryExposureBucket> = {};
  for (const [key, bucket] of Object.entries(options.byCategory ?? {})) {
    const id = normalizeCategory(key);
    if (!id) continue;
    categoryUsage[id] = {
      openMarkets: bucket.openMarkets,
      openExposureUsdc: bucket.openExposureUsdc,
      claimIds: [...bucket.claimIds],
    };
  }

  let openExposureUsdc = options.openExposureUsdc;
  const accepted: ClaimCandidate[] = [];
  const rejected: CreatorCandidateDecision[] = [];
  const decisions: CreatorCandidateDecision[] = [];
  const countsByDecisionCode: Partial<Record<CreatorDecisionCode, number>> = {};

  function record(decision: CreatorCandidateDecision): void {
    decisions.push(decision);
    countsByDecisionCode[decision.decisionCode] =
      (countsByDecisionCode[decision.decisionCode] ?? 0) + 1;
    if (decision.accepted) {
      accepted.push(decision.candidate);
    } else {
      rejected.push(decision);
    }
  }

  for (const candidate of candidates) {
    const categoryKey = normalizeCategory(candidate.category) ?? undefined;

    // 1. Source-quality checks (score, URL allowlist, crypto threshold sanity).
    if (
      options.minQualityScore !== undefined &&
      (typeof candidate.qualityScore !== "number" ||
        candidate.qualityScore < options.minQualityScore)
    ) {
      record({
        candidate,
        accepted: false,
        decisionCode: "source_quality_rejected",
        category: categoryKey,
        reason: `quality ${String(candidate.qualityScore)} < ${options.minQualityScore}`,
      });
      continue;
    }

    if (allowedUrls !== null) {
      const candidateUrl = normaliseUrlForAllowlist(candidate.resolutionUrl ?? "");
      if (!candidateUrl || !allowedUrls.has(candidateUrl)) {
        record({
          candidate,
          accepted: false,
          decisionCode: "source_quality_rejected",
          category: categoryKey,
          reason: `resolutionUrl not in allowlist: ${candidate.resolutionUrl}`,
        });
        continue;
      }
    }

    if (candidate.threshold !== undefined) {
      const thresholdIssue = cryptoThresholdReason(candidate.threshold);
      if (thresholdIssue !== null) {
        record({
          candidate,
          accepted: false,
          decisionCode: "source_quality_rejected",
          category: categoryKey,
          reason: thresholdIssue,
        });
        continue;
      }
    }

    // 2. Duplicate check against existing and already-admitted candidates.
    const signature = buildCandidateSignature(candidate);
    if (seen.has(signature)) {
      record({
        candidate,
        accepted: false,
        decisionCode: "duplicate_candidate",
        category: categoryKey,
        reason: `duplicate candidate signature: ${signature}`,
      });
      continue;
    }

    // 3. Exact global USDC exposure cap check.
    const exposureGate = checkCreatorExposureCap({
      openExposureUsdc,
      stakeUsdc: options.stakeUsdc,
      maxOpenExposureUsdc: options.maxOpenExposureUsdc,
    });
    if (!exposureGate.allowed) {
      record({
        candidate,
        accepted: false,
        decisionCode: "exposure_cap_exceeded",
        category: categoryKey,
        reason: exposureGate.blockedBy,
        openExposureUsdc: exposureGate.openExposureUsdc,
        nextExposureUsdc: exposureGate.nextExposureUsdc,
      });
      continue;
    }

    // 4. Per-category budget & kill-switch check.
    const bucket = (categoryKey ? categoryUsage[categoryKey] : undefined) ?? {
      openMarkets: 0,
      openExposureUsdc: 0,
      claimIds: [],
    };
    const categoryGate = checkCategoryCreatorCap({
      category: candidate.category,
      policy: options.categoryCaps,
      openMarkets: bucket.openMarkets,
      openExposureUsdc: bucket.openExposureUsdc,
      stakeUsdc: options.stakeUsdc,
      categoryEnabled: options.isCategoryEnabled
        ? options.isCategoryEnabled(candidate.category)
        : true,
    });
    if (!categoryGate.allowed) {
      const decisionCode: CreatorDecisionCode =
        categoryGate.reason === "cap_exceeded"
          ? "category_budget_exhausted"
          : categoryGate.reason === "category_disabled"
            ? "category_disabled"
            : "category_cap_invalid";
      record({
        candidate,
        accepted: false,
        decisionCode,
        category: categoryGate.category ?? categoryKey,
        limitedBy: categoryGate.reason === "cap_exceeded" ? categoryGate.limitedBy : undefined,
        reason: categoryGate.blockedBy,
        openExposureUsdc: categoryGate.openExposureUsdc,
        nextExposureUsdc: categoryGate.nextExposureUsdc,
      });
      continue;
    }

    // 5. Accepted — update seen set and optimistic USDC / category accounting.
    seen.add(signature);
    openExposureUsdc = exposureGate.nextExposureUsdc;
    bumpCategoryUsage(categoryUsage, candidate.category, options.stakeUsdc);
    record({
      candidate,
      accepted: true,
      decisionCode: "approved",
      category: categoryGate.category ?? categoryKey,
      openExposureUsdc: exposureGate.openExposureUsdc,
      nextExposureUsdc: exposureGate.nextExposureUsdc,
    });
  }

  return {
    accepted,
    rejected,
    decisions,
    countsByDecisionCode,
    summary: {
      total: candidates.length,
      accepted: accepted.length,
      rejected: rejected.length,
      sourceQualityRejected: countsByDecisionCode.source_quality_rejected ?? 0,
      categoryBudgetExhausted: countsByDecisionCode.category_budget_exhausted ?? 0,
      exposureCapExceeded: countsByDecisionCode.exposure_cap_exceeded ?? 0,
      duplicateRejected: countsByDecisionCode.duplicate_candidate ?? 0,
    },
    openExposureUsdc,
    remainingExposureUsdc: Math.max(0, options.maxOpenExposureUsdc - openExposureUsdc),
    categoryUsage,
  };
}
