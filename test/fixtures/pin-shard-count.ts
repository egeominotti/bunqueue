/**
 * Preload for the write-path fault matrix: shard count is derived from
 * navigator.hardwareConcurrency when src/shared/hash.ts loads. Pinning 18
 * cores (32 shards, the recording host) keeps batch extraction order, and so
 * the recorded 2.9.11 outcomes, identical on hosts with fewer cores.
 */
Object.defineProperty(globalThis.navigator, 'hardwareConcurrency', {
  value: 18,
  configurable: true,
});
