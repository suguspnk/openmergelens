export const MAX_REVIEW_BATCH_SIZE = 10;
// A review can retain a host-side diff, gateway inspection pages, prompt data,
// and a reviewer process at the same time. Keep the aggregate below the
// machine-wide memory pressure that ten maximum-size reviews could create.
export const MAX_CONCURRENT_REVIEW_ADMISSIONS = 3;
export const MAX_REVIEWS_PER_POLL = 20;
export const MAX_STATE_GC_CHECKS_PER_POLL = 25;
export const MAX_STATE_FILE_BYTES = 16 * 1024 * 1024;
export const MAX_REVIEW_STATE_ENTRIES = 10_000;
export const MAX_CONFIGURED_REVIEW_SCOPES = 10_000;
export const REVIEW_STATE_RETENTION_DAYS = 365;
export const MAX_REVIEW_STATE_FUTURE_SKEW_MS = 5 * 60 * 1_000;
export const MAX_REVIEW_STATE_KEY_CHARS = 1_024;
export const MAX_REVIEW_STATE_SHA_CHARS = 128;
export const MAX_REVIEW_STATE_TIMESTAMP_CHARS = 64;
export const MAX_REVIEW_STATE_GC_CURSOR_CHARS = 1_024;
export const MAX_ACTIVE_REVIEW_REQUEST_USERS = 1_000;
export const MAX_GITHUB_REVIEWS_FOR_RECONCILIATION = 10_000;
// Stay below Codex's 1,048,576-character request ceiling after UTF-8
// serialization and leave headroom for transport framing.
export const MAX_REVIEW_PROMPT_BYTES = 900_000;
export const MAX_REVIEW_STDOUT_BYTES = 2 * 1024 * 1024;
export const MAX_REVIEW_STDERR_BYTES = 256 * 1024;
export const MAX_REVIEW_SUMMARY_CHARS = 16_000;
export const MAX_REVIEW_FINDINGS = 50;
export const MAX_REVIEW_COMMENT_CHARS = 4_000;
export const MAX_REVIEW_PATH_CHARS = 512;
// Includes summary + comments. 28k leaves room under GitHub's 60k review-body
// cap for fifty maximum-length paths plus markdown/location formatting when
// every finding must be demoted from inline to the review body.
export const MAX_REVIEW_TOTAL_TEXT_CHARS = 28_000;
export const MAX_GITHUB_REVIEW_BODY_CHARS = 60_000;
// Keep diff-anchor validation from retaining an unbounded path:line set for a
// large but otherwise allowed GitHub diff. Overflow fails closed so no
// finding can be posted inline without a validated anchor.
export const MAX_DIFF_ANCHORS = 100_000;
export const MAX_DIFF_ANCHOR_CHARS = 8 * 1024 * 1024;
export const REVIEWER_HARD_KILL_GRACE_MS = 1_000;
export const MAX_GH_OUTPUT_BYTES = 32 * 1024 * 1024;
