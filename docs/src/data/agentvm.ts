// agentvm, a separate project by the bunqueue author that runs Claude Code agents in
// disposable Debian VMs on a Mac. It does not use bunqueue. The homepage section renders
// from this file. Every claim and figure comes from the agentvm README, and the
// screenshots in public/agentvm/ are copies of its docs/assets (egeominotti/agentvm at
// b8cb3bc, 2026-10-09); refresh both together by hand.

export const AGENTVM_REPO = 'https://github.com/egeominotti/agentvm';

export interface AgentvmStep {
  /** Anchor-safe id for the tab and its panel. */
  readonly id: string;
  /** Short tab label on narrow screens. */
  readonly label: string;
  readonly title: string;
  /** File in public/agentvm/. */
  readonly image: string;
  readonly width: number;
  readonly height: number;
  readonly alt: string;
  /** Paragraphs of trusted static HTML (inline <code> only). */
  readonly body: readonly string[];
}

const SCREEN = { width: 1800, height: 1125 } as const;

export const agentvmSteps: readonly AgentvmStep[] = [
  {
    id: 'install',
    label: 'Install',
    title: 'One command builds it and starts it',
    image: 'quickstart.webp',
    width: 1021,
    height: 540,
    alt: './quickstart: tools checked, only what changed rebuilt, server restarted with its VMs still running',
    body: [
      '<code>./quickstart</code> checks the tools (Swift, Rust and Bun), builds the VM helper, the dashboard and the server, and opens the dashboard on <code>127.0.0.1:7777</code>. The first run also builds the VM image, Debian 13 with Claude Code: about 2 minutes, once.',
      'Run it again after every <code>git pull</code>: it rebuilds only what changed, takes about a second when nothing did, and running VMs re-attach to the new server. Save your Claude token once, from <code>claude setup-token</code>, in Settings › Claude account; it goes to the macOS Keychain.',
    ],
  },
  {
    id: 'launch',
    label: 'Launch',
    title: 'A new VM in about 2 seconds',
    image: 'boot.webp',
    ...SCREEN,
    alt: 'The boot sequence of a VM, with the time of each step',
    body: [
      'Press New VM (<code>⌘K</code>) and give it a folder on your Mac or a git link: <code>github.com/owner/repo</code>, <code>owner/repo</code>, https or ssh, on any host. Pick the branch, the model, the Claude Code version, vCPUs and memory. Private repositories open with your Mac’s own git access or a token saved per host.',
      'The boot is shown as it happens, from real events with their timings: a slot is reserved, the disk is cloned from the prebuilt image in milliseconds, Debian boots, the repository is checked out, the network comes up and Claude Code is ready. A <code>.agentvm/setup.sh</code> in the repository runs as root before Claude starts.',
    ],
  },
  {
    id: 'work',
    label: 'Work',
    title: 'Claude as root, in terminals you drive',
    image: 'machine.webp',
    ...SCREEN,
    alt: 'A machine: Claude Code’s finished work, its telemetry and a dev server on port 3000 open on the Mac',
    body: [
      'Claude Code runs as root with every permission (<code>--dangerously-skip-permissions</code>) on a fresh checkout in <code>/root/work</code>. It can install packages, start servers and break things: the VM sees only its own job folder, and your files and your checkout never enter it.',
      'Each VM has a Claude tab and up to nine shells, real terminals in the browser that survive a page reload. A web service in the VM appears in the bar above at its own address, <code>http://3000.&lt;vm&gt;.localhost:7777</code>, so every VM can serve port 3000 at once. On the right: CPU, memory, disk and network, plus Claude’s conversation, cost and tokens. Tailscale is one click away.',
    ],
  },
  {
    id: 'machines',
    label: 'All VMs',
    title: 'Every agent on one screen',
    image: 'wall.webp',
    ...SCREEN,
    alt: 'The Machines page: ten VMs, seven Claude Code agents waiting for review and three terminals ready',
    body: [
      'The Machines page counts what is running, what waits for you and what is still working, the memory in use and what Claude has spent. Each card is a live view of a VM’s terminal, with its CPU, memory, open ports and cost.',
      'Here ten VMs share one Mac: seven agents have finished and wait for review, three terminals are ready, and 4.7 GB of memory is in use. Search and filter them, switch to the list, and find closed ones under Finished.',
    ],
  },
  {
    id: 'save',
    label: 'Save',
    title: 'The work comes back as a branch',
    image: 'machines-list.webp',
    ...SCREEN,
    alt: 'The Machines page as a list: status, CPU, memory, ports, Claude’s spend and uptime of ten VMs',
    body: [
      'As a list, every VM shows its status, CPU, memory, ports, Claude’s spend and uptime, with Open, Save, Snapshot and Close.',
      'Save commits whatever the agent left uncommitted and copies the VM’s commits to <code>agent/&lt;id&gt;</code> in your repository while the VM keeps running; Close saves, then shuts it down. Review it with <code>git switch agent/&lt;id&gt;</code>, take it with <code>git merge</code>, or push it to origin from the dashboard (never forced) with a link to its pull request.',
    ],
  },
  {
    id: 'snapshots',
    label: 'Snapshots',
    title: 'Freeze a VM, restore it later',
    image: 'snapshots.webp',
    ...SCREEN,
    alt: 'The Snapshots page: a summary, then the snapshots of each machine with what deleting each one frees',
    body: [
      'A snapshot freezes the whole VM: files, installed packages and Claude’s conversation. Take one by hand, or let agentvm take one every 30 minutes (it keeps the newest 4 per VM) and one more just before a VM closes. Restore any of them into a new VM, where Claude continues its last conversation.',
      'Disks are stored as 1 MiB chunks named by their BLAKE3 hash and compressed with zstd, and a chunk shared by several snapshots is stored once: here four snapshots of four machines take 853 MB in all, each adding only what changed. Export one as <code>.tar.zst</code>, import it on another Mac, or back it up to any S3-compatible storage.',
    ],
  },
  {
    id: 'resources',
    label: 'Resources',
    title: 'As many VMs as your Mac can hold',
    image: 'settings.webp',
    ...SCREEN,
    alt: 'Settings › Resources: vCPUs and memory per VM, VMs at the same time, and the memory budget of this Mac',
    body: [
      'Set the vCPUs and memory each new VM gets and how many run at the same time; more launches wait in a queue, in order. By default agentvm runs as many as fit in memory and keeps 8 GB for macOS: 14 VMs of 4 GB on a 64 GB Mac.',
      'A VM starts only when macOS reports the memory free, and one idle for 60 seconds gives back everything but what it uses plus 1 GB. Settings also hold your Claude account, git access, Tailscale, backups and the VM image, with every secret in the macOS Keychain.',
    ],
  },
];

export const agentvmInternals = [
  {
    title: 'A golden image',
    body: 'Debian’s official arm64 cloud image, made ready with Claude Code, git, build tools, Python, Node, Chromium, tmux and zsh. Each VM starts from an APFS clone of it.',
  },
  {
    title: 'One process per VM',
    body: 'A small Swift helper on Apple’s Virtualization.framework owns one VM. A crashing VM never takes the Rust server down, and the server restarts without stopping VMs.',
  },
  {
    title: 'No network for control',
    body: 'The repository goes in and comes back as a git bundle through the VM’s own virtiofs folder; terminals and forwarded ports travel over vsock.',
  },
  {
    title: 'Local only',
    body: 'The dashboard and every forwarded port listen on 127.0.0.1, and requests from other hosts or sites are rejected. Git tokens and the S3 key never leave the Mac.',
  },
] as const;

/** Measured by the agentvm README on an M5 Max (18 cores, 64 GB). */
export const agentvmFigures = [
  { value: '2.0 s', label: 'New VM to a ready terminal' },
  { value: '1.05 s', label: 'Debian boot inside it' },
  { value: '~2 ms', label: 'Keystroke to echo, through the server and the VM' },
  { value: '1.19 GB', label: 'Six real snapshots as shared chunks, instead of ~20 GB' },
] as const;
