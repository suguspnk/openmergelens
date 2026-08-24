export const TEST_TIMEOUT_MS = 30_000;
export const LARGE_STATE_TEST_TIMEOUT_MS = 60_000;

const alphabeticPartitions = [
  '^[A-Fa-f]',
  '^[G-Lg-l]',
  '^[M-Rm-r]',
  '^[S-Zs-z]',
];

// The poller suite's A-F window contains several state-capacity and
// reconciliation scenarios that exceed the hosted Windows 30-second test
// timeout. In particular, the safety-cap and already-posted tests each perform
// many durable Windows writes. Keep the default timeout unchanged and split
// only that file's window so each title still belongs to one deterministic
// partition.
const pollerTestPartitions = [
  '^account',
  '^a (?:changed|compacted|diff|dry|failed|foreign|head)',
  '^a (?:PR|posted|rate-limited|requested|review|revoked|search)',
  '^(?:already|an )',
  '^[Bb]',
  '^[Cc]',
  '^[D-Fd-f]',
  '^[G-Lg-l]',
  '^[Mm]',
  '^[Nn]',
  '^[Oo]',
  '^[Pp]',
  '^[Q-Rq-r]',
  '^[Ss]',
  '^[Tt]',
  '^[U-Zu-z]',
];

// The state suite contains many Windows retention and identity regressions.
// Run those separately from the cross-platform state cases so a slow hosted
// filesystem cannot cancel the whole file while preserving the same per-test
// timeout and every fail-closed assertion.
const stateTestPartitions = [
  '^[A-Fa-f]',
  '^[G-Lg-l]',
  '^[M-Rm-r]',
  '^[Ss]',
  '^[T-Vt-v]',
  '^Windows (?:retention|retained)',
  '^Windows (?:cleanup|file|simulated|state)',
];

export const partitionPatterns = new Map([
  ['poller-performance.test.mjs', alphabeticPartitions],
  ['poller-state-gc-capacity.test.mjs', [
    '^[A-Ka-k]',
    '^legacy (?:auth|repair (?:deadline|persists))',
    '^legacy over-cap (?:state|repair (?:adopts|bounds|counts|stops))',
    '^legacy over-cap (?:deadline|expiry|repair (?:accumulates|performs|persists|progress))',
    '^[M-Zm-z]',
  ]],
  ['poller.test.mjs', pollerTestPartitions],
  ['state.test.mjs', stateTestPartitions],
]);
