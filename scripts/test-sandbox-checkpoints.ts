/**
 * Quiescent cgroup checkpoints for multi-step sandbox suites.
 *
 * An SDK suite is a chain of different short-lived processes (format, compile, native
 * tests, conformance runner + broker + driver). Its first and last `docker stats`
 * samples land in whichever phases happen to be running ~2 s after start and just
 * before exit, so "end minus start" compares two different workloads, and the first
 * sample's position alone swung the Elixir delta between +45 and +341 MiB.
 *
 * The wrapper reads the container's own cgroup v2 files from inside the container at
 * two equivalent, idle points: before the suite command starts, and after it AND every
 * process it left behind have exited (bounded settle). Retained memory is anonymous
 * memory plus tmpfs (`anon + shmem`); reclaimable page cache from build outputs is
 * reported but not counted. Any process still alive after the settle window outlived
 * the command that started it, which is the leak class a container-level sampler can
 * actually prove.
 */

export const CHECKPOINT_MARKER = 'BUNQUEUE_SANDBOX_CHECKPOINT';
const SETTLE_POLLS = 20;
const SETTLE_POLL_SECONDS = '0.5';

// Pure bash plus `sleep`, which every SDK image has. PID 1 is docker-init (`--init`)
// and `$$` is this wrapper; everything else visible after the settle window survived.
// BUNQUEUE_SANDBOX_SETTLE_POLLS overrides the poll count only for unit tests, which run
// the wrapper in a shared container where unrelated processes would hold the window.
const WRAPPER = `
cg=/sys/fs/cgroup
survivors() {
  local entry pid comm
  list=
  for entry in /proc/[0-9]*; do
    pid=\${entry#/proc/}
    [[ $pid == 1 || $pid == "$$" ]] && continue
    { read -r comm < "$entry/comm"; } 2>/dev/null || continue
    list+="\${list:+,}\${comm//[^A-Za-z0-9._+-]/_}"
  done
}
checkpoint() {
  local key value anon=-1 shmem=-1 file=-1 inactive=-1 current=-1 pids=-1
  if [[ -r $cg/memory.stat && -r $cg/memory.current ]]; then
    while read -r key value; do
      case $key in
        anon) anon=$value ;; shmem) shmem=$value ;;
        file) file=$value ;; inactive_file) inactive=$value ;;
      esac
    done < $cg/memory.stat
    read -r current < $cg/memory.current
  fi
  [[ -r $cg/pids.current ]] && read -r pids < $cg/pids.current
  survivors
  printf '%s {"phase":"%s","anonBytes":%s,"shmemBytes":%s,"fileBytes":%s,"inactiveFileBytes":%s,"currentBytes":%s,"pids":%s,"processes":"%s"}\\n' \\
    ${CHECKPOINT_MARKER} "$1" "$anon" "$shmem" "$file" "$inactive" "$current" "$pids" "$list"
}
checkpoint before
"$@"
status=$?
for ((poll = 0; poll < \${BUNQUEUE_SANDBOX_SETTLE_POLLS:-${SETTLE_POLLS}}; poll++)); do
  survivors
  [[ -z $list ]] && break
  sleep ${SETTLE_POLL_SECONDS}
done
checkpoint after
exit "$status"
`;

export function withQuiescentCheckpoints(command: readonly string[]): string[] {
  return ['bash', '-c', WRAPPER, 'sandbox-checkpoint', ...command];
}

export interface QuiescentCheckpoint {
  phase: 'before' | 'after';
  anonBytes: number;
  shmemBytes: number;
  fileBytes: number;
  inactiveFileBytes: number;
  currentBytes: number;
  pids: number;
  processes: string[];
}

export interface QuiescentResidual {
  before: QuiescentCheckpoint;
  after: QuiescentCheckpoint;
  /** after(anon + shmem) - before(anon + shmem): memory still held once the suite is gone. */
  retainedBytes: number;
  /** Process names still alive after the command exited and the settle window elapsed. */
  survivors: string[];
}

function parseCheckpoint(json: string): QuiescentCheckpoint | null {
  try {
    const raw = JSON.parse(json) as Record<string, unknown>;
    const numbers = [
      'anonBytes',
      'shmemBytes',
      'fileBytes',
      'inactiveFileBytes',
      'currentBytes',
      'pids',
    ] as const;
    if (raw.phase !== 'before' && raw.phase !== 'after') return null;
    // -1 means the cgroup file was unreadable; a checkpoint without memory is no checkpoint.
    if (!numbers.every((key) => typeof raw[key] === 'number' && (raw[key] as number) >= 0))
      return null;
    const processes = typeof raw.processes === 'string' ? raw.processes : '';
    return {
      phase: raw.phase,
      anonBytes: raw.anonBytes as number,
      shmemBytes: raw.shmemBytes as number,
      fileBytes: raw.fileBytes as number,
      inactiveFileBytes: raw.inactiveFileBytes as number,
      currentBytes: raw.currentBytes as number,
      pids: raw.pids as number,
      processes: processes ? processes.split(',') : [],
    };
  } catch {
    return null;
  }
}

/** Returns null unless the log holds one valid `before` and one valid `after` checkpoint. */
export function quiescentResidual(log: string): QuiescentResidual | null {
  const found: Partial<Record<'before' | 'after', QuiescentCheckpoint>> = {};
  // Every marker line must be a valid reading: a truncated or corrupted one voids both.
  for (const match of log.matchAll(new RegExp(`^${CHECKPOINT_MARKER} (.*)$`, 'gm'))) {
    const checkpoint = parseCheckpoint(match[1]);
    if (!checkpoint) return null;
    // The suite command's own output can never legitimately repeat a phase.
    if (found[checkpoint.phase]) return null;
    found[checkpoint.phase] = checkpoint;
  }
  const { before, after } = found;
  if (!before || !after) return null;
  return {
    before,
    after,
    retainedBytes: after.anonBytes + after.shmemBytes - (before.anonBytes + before.shmemBytes),
    survivors: after.processes,
  };
}

export function summarizeProcesses(names: readonly string[]): string {
  const counts = new Map<string, number>();
  for (const name of names) counts.set(name, (counts.get(name) ?? 0) + 1);
  return [...counts]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, count]) => (count > 1 ? `${name} x${count}` : name))
    .join(', ');
}

export function quiescentAnomalies(residual: QuiescentResidual): string[] {
  const anomalies: string[] = [];
  const baseline = residual.before.anonBytes + residual.before.shmemBytes;
  if (residual.retainedBytes >= 128 * 1024 ** 2 && residual.retainedBytes >= baseline * 0.5)
    anomalies.push(
      'memory growth signal: quiescent end minus start (anon+shmem) exceeds 128 MiB and 50%'
    );
  if (residual.survivors.length > 0)
    anomalies.push(
      `processes outlived the suite command: ${summarizeProcesses(residual.survivors)}`
    );
  return anomalies;
}
