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
// timeout. Keep the default timeout unchanged and split only that file's
// window so each title still belongs to exactly one deterministic partition.
const pollerTestPartitions = [
  '^[A-Ca-c]',
  '^[D-Fd-f]',
  ...alphabeticPartitions.slice(1),
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
]);
