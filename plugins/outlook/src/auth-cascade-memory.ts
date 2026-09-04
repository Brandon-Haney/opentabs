// ---------------------------------------------------------------------------
// Auth cascade memory — the negative cache of rejected token candidates
//
// The SDK auth-cache helpers hold one accepted token per slot (the positive
// cache). This module remembers, per slot, which candidates a Microsoft API
// answered with 401/403, so the cascade does not re-pay a known rejection on
// every call that fails to reach `setAuthCache`. It is module state: it lives
// as long as the adapter is injected in the page (a `plugin.update`
// re-injection starts empty, costing one extra cascade), and it holds the same
// secrets that already sit in the page's localStorage and in the token cache.
// `listRejected` exposes descriptors only — never a token.
// ---------------------------------------------------------------------------

import { tokenFingerprint } from './token-fingerprint.js';

/** The two fields a rejection is keyed by: the same token is judged per API base. */
export interface CascadeCandidate {
  token: string;
  apiBase: string;
}

/** A remembered rejection, safe to return from a tool: it carries no secret. */
export interface RejectedCandidate {
  apiBase: string;
  fingerprint: string;
  rejectedAt: number;
}

/** slot → candidate key → rejection. Bounded by the number of distinct MSAL tokens present. */
const rejectedBySlot = new Map<string, Map<string, RejectedCandidate>>();

const candidateKey = (candidate: CascadeCandidate): string => `${candidate.apiBase}\n${candidate.token}`;

/** Records that `candidate` was answered with 401/403 in `slot`. */
export const rememberRejected = (slot: string, candidate: CascadeCandidate, rejectedAt = Date.now()): void => {
  let slotMemory = rejectedBySlot.get(slot);
  if (slotMemory === undefined) {
    slotMemory = new Map();
    rejectedBySlot.set(slot, slotMemory);
  }
  slotMemory.set(candidateKey(candidate), {
    apiBase: candidate.apiBase,
    fingerprint: tokenFingerprint(candidate.token),
    rejectedAt,
  });
};

/** True when `candidate` is remembered as rejected in `slot`. */
export const isRejected = (slot: string, candidate: CascadeCandidate): boolean =>
  rejectedBySlot.get(slot)?.has(candidateKey(candidate)) === true;

/** Clears every rejection remembered for `slot`. */
export const forgetRejected = (slot: string): void => {
  rejectedBySlot.delete(slot);
};

/** The rejections remembered for `slot`, as secret-free descriptors. */
export const listRejected = (slot: string): readonly RejectedCandidate[] => [
  ...(rejectedBySlot.get(slot)?.values() ?? []),
];

/**
 * The candidates worth trying in `slot`, in their original order, minus the
 * remembered rejections. When every candidate is remembered as rejected, the
 * slot's memory is cleared and every candidate is returned once more: MSAL
 * refreshes tokens silently and a 403 can be a transient authorization-cache
 * miss, so a full rejection is retried rather than treated as permanent. An
 * empty candidate list leaves the memory untouched.
 */
export const eligibleCandidates = <T extends CascadeCandidate>(slot: string, candidates: readonly T[]): T[] => {
  if (candidates.length === 0) return [];
  const remaining = candidates.filter(candidate => !isRejected(slot, candidate));
  if (remaining.length > 0) return remaining;
  forgetRejected(slot);
  return [...candidates];
};

/** Clears every slot. */
export const resetCascadeMemory = (): void => {
  rejectedBySlot.clear();
};
