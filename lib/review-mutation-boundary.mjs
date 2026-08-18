export const REVIEW_MUTATION_BOUNDARY_CODE =
  'ERR_OPENMERGELENS_REVIEW_MUTATION_BOUNDARY';

const VALID_REASONS = new Set(['stale', 'closed', 'revoked']);

export class ReviewMutationBoundaryError extends Error {
  constructor(reason) {
    if (!VALID_REASONS.has(reason)) {
      throw new Error(`invalid review mutation boundary reason: ${reason}`);
    }
    super(`review mutation boundary rejected: ${reason}`);
    this.name = 'ReviewMutationBoundaryError';
    this.code = REVIEW_MUTATION_BOUNDARY_CODE;
    this.reason = reason;
  }
}

export function mutationBoundaryReason(error) {
  let current = error;
  while (current) {
    if (
      current.code === REVIEW_MUTATION_BOUNDARY_CODE &&
      VALID_REASONS.has(current.reason)
    ) {
      return current.reason;
    }
    current = current.cause;
  }
  return null;
}
