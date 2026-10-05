import { resolveToken } from '../client/resolveToken';
import { parseNumericFlag, parsePortFlagLeniently, shownFlagValue } from '../config/cliFlags';
import { parseWholeEnv, type WholeRule } from '../config/numbers';
import { SETTINGS } from '../config/settings';

export interface GlobalOptions {
  host: string;
  port: number;
  token?: string;
  tls?: boolean | { rejectUnauthorized?: boolean; caFile?: string };
  json: boolean;
  help: boolean;
  version: boolean;
}

interface TlsFlagState {
  enabled: boolean;
  noVerify: boolean;
  caFile?: string;
}

interface HostPortState {
  host: string;
  hostExplicit: boolean;
  /** The port flag as typed (`-p`, `--port`) and its raw value; parsed after the loop. */
  portFlag?: { flag: string; raw: string | boolean };
}

const DEFAULT_CLIENT_PORT = 6789;
/** A client connects to a real port: 0 (OS-assigned) only makes sense for a server. */
const CLIENT_PORT: WholeRule = { min: 1, max: 65_535 };
const ENV_PORTS = ['TCP_PORT', 'BUNQUEUE_TCP_PORT', 'BQ_TCP_PORT'] as const;

/**
 * The client port from the env, resolved as `TCP_PORT ?? BUNQUEUE_TCP_PORT ?? BQ_TCP_PORT`
 * (an empty TCP_PORT means the default; the aliases are not read). A value that is not a
 * port warns and uses 6789, as 2.9.10 did: Kubernetes injects
 * `BUNQUEUE_TCP_PORT=tcp://10.96.0.12:6789` for a Service named `bunqueue-tcp`, which
 * must not break every client command. An explicit `--port` stays strict.
 */
function resolveEnvPort(): number {
  const name = ENV_PORTS.find((key) => Bun.env[key] !== undefined);
  const raw = name === undefined ? undefined : Bun.env[name];
  if (name === undefined || !raw) return DEFAULT_CLIENT_PORT;
  try {
    return parseWholeEnv(name, raw, DEFAULT_CLIENT_PORT, CLIENT_PORT);
  } catch {
    console.warn(
      `Warning: Invalid env port "${raw}" (${name}: expected a whole number between 1 and 65535). Using ${DEFAULT_CLIENT_PORT}.`
    );
    return DEFAULT_CLIENT_PORT;
  }
}

/**
 * The global port flag. On a client command it must be 1-65535, and an invalid or
 * missing value throws a ConfigError naming the flag as typed. In server mode it is
 * re-injected as `--tcp-port` (0-65535, 0 = OS-assigned); a value that is not a port is
 * dropped with a warning (undefined), as in 2.9.10, and a misread still throws.
 */
function parsePortFlag(
  portFlag: NonNullable<HostPortState['portFlag']>,
  serverMode: boolean
): number | undefined {
  if (!serverMode) {
    return parseNumericFlag(
      { ...SETTINGS.tcpPort, flag: portFlag.flag, rule: CLIENT_PORT },
      portFlag.raw
    );
  }
  // On `start`, 2.9.10 warned about a value that is not a port and dropped it (the
  // server then used TCP_PORT or 6789); a misread still stops startup.
  const port = parsePortFlagLeniently(portFlag.flag, portFlag.raw, SETTINGS.tcpPort.rule);
  if (port === undefined) {
    console.warn(
      `Warning: Invalid ${portFlag.flag} ${shownFlagValue(portFlag.raw)} (expected a whole number between 0 and 65535). Ignoring it; the server port applies.`
    );
  }
  return port;
}

function resolveEnvHost(currentHost: string): string {
  return Bun.env.HOST ?? Bun.env.BUNQUEUE_HOST ?? Bun.env.BQ_HOST ?? currentHost;
}

function applyTlsFlag(
  arg: string,
  allArgs: string[],
  index: number,
  state: TlsFlagState,
  commandArgs: string[]
): number {
  if (arg === '--tls') {
    state.enabled = true;
    return index;
  }
  if (arg === '--tls-no-verify') {
    state.noVerify = true;
    return index;
  }
  if (arg === '--tls-ca') {
    const value = allArgs[index + 1];
    if (value === undefined || value.startsWith('-')) {
      console.warn('Warning: --tls-ca requires a file path. Option ignored.');
      return index;
    }
    state.caFile = value;
    return index + 1;
  }
  if (arg.startsWith('--tls-ca=')) {
    const value = arg.slice(9);
    if (value) state.caFile = value;
    else console.warn('Warning: --tls-ca= requires a file path. Option ignored.');
    return index;
  }
  commandArgs.push(arg);
  return index;
}

function buildTlsOption(state: TlsFlagState): GlobalOptions['tls'] {
  if (state.noVerify || state.caFile !== undefined) {
    return {
      ...(state.noVerify && { rejectUnauthorized: false }),
      ...(state.caFile !== undefined && { caFile: state.caFile }),
    };
  }
  return state.enabled ? true : undefined;
}

function commandOwnsShortT(commandArgs: string[]): boolean {
  return commandArgs[0] === 'pull' || (commandArgs[0] === 'job' && commandArgs[1] === 'wait');
}

function applyTokenFlag(
  arg: string,
  allArgs: string[],
  index: number,
  state: { token?: string },
  commandArgs: string[]
): number {
  if (arg === '-t' && commandOwnsShortT(commandArgs)) {
    commandArgs.push(arg);
    return index;
  }
  const value = allArgs[index + 1];
  if (value === undefined || value.startsWith('-')) {
    console.warn('Warning: --token requires a value. Token not set.');
    return index;
  }
  state.token = value;
  return index + 1;
}

function applyHostFlag(allArgs: string[], index: number, state: HostPortState): number {
  const value = allArgs[index + 1];
  if (value === undefined || value.startsWith('-')) {
    console.warn('Warning: --host requires a value. Using localhost.');
    return index;
  }
  state.host = value;
  state.hostExplicit = true;
  return index + 1;
}

function applyPortFlag(
  flag: string,
  allArgs: string[],
  index: number,
  state: HostPortState
): number {
  const value = allArgs[index + 1];
  // `-p -1` is a (wrong) number, `-p --json` is a missing value, `-p ''` is not given.
  if (value === undefined || (value.startsWith('-') && !/^-\d/.test(value))) {
    state.portFlag = { flag, raw: true };
    return index;
  }
  if (value !== '') state.portFlag = { flag, raw: value };
  return index + 1;
}

function warnAmbiguousAttachedShort(arg: string, commandArgs: string[]): void {
  if (!/^-[Hpthv][^-\s]/.test(arg)) return;
  if (arg.startsWith('-t') && commandOwnsShortT(commandArgs)) return;
  console.warn(
    `Warning: "${arg}" looks like a short flag with an attached value; ` +
      `use the separated form ("${arg.slice(0, 2)} ${arg.slice(2)}") or the long form.`
  );
}

export function parseGlobalOptions(allArgs = process.argv.slice(2)): {
  options: GlobalOptions;
  commandArgs: string[];
} {
  const hp: HostPortState = { host: 'localhost', hostExplicit: false };
  const tokenState: { token?: string } = {};
  const tlsState: TlsFlagState = { enabled: false, noVerify: false };
  const commandArgs: string[] = [];
  let json = false;
  let help = false;
  let version = false;

  for (let index = 0; index < allArgs.length; index++) {
    const arg = allArgs[index];
    if (arg === '--') {
      commandArgs.push(...allArgs.slice(index + 1));
      break;
    }
    if (arg === '--host' || arg === '-H') {
      index = applyHostFlag(allArgs, index, hp);
    } else if (arg === '--port' || arg === '-p') {
      index = applyPortFlag(arg, allArgs, index, hp);
    } else if (arg === '--token' || arg === '-t') {
      index = applyTokenFlag(arg, allArgs, index, tokenState, commandArgs);
    } else if (arg.startsWith('--tls')) {
      index = applyTlsFlag(arg, allArgs, index, tlsState, commandArgs);
    } else if (arg === '--json') {
      json = true;
    } else if (arg === '--help' || (arg === '-h' && commandArgs.length === 0)) {
      help = true;
    } else if (arg === '--version' || (arg === '-v' && commandArgs.length === 0)) {
      version = true;
    } else if (arg.startsWith('--host=')) {
      // `--host=` / `--port=` (empty) mean "not given": env or default, as in 2.9.10.
      if (arg.length > 7) {
        hp.host = arg.slice(7);
        hp.hostExplicit = true;
      }
    } else if (arg.startsWith('--port=')) {
      if (arg.length > 7) hp.portFlag = { flag: '--port', raw: arg.slice(7) };
    } else if (arg.startsWith('--token=')) {
      const value = arg.slice(8);
      if (value) tokenState.token = value;
      else console.warn('Warning: --token= requires a value. Token not set.');
    } else {
      warnAmbiguousAttachedShort(arg, commandArgs);
      commandArgs.push(arg);
    }
  }

  const serverMode =
    commandArgs[0] === 'start' || commandArgs.length === 0 || commandArgs[0]?.startsWith('-');
  const explicitPort = hp.portFlag ? parsePortFlag(hp.portFlag, serverMode) : undefined;
  if (serverMode) {
    if (hp.hostExplicit) commandArgs.push('--host', hp.host);
    if (explicitPort !== undefined) commandArgs.push('--tcp-port', String(explicitPort));
  }

  return {
    options: {
      host: hp.hostExplicit ? hp.host : resolveEnvHost(hp.host),
      // In server mode the port is the server's (validated by resolveServerConfig).
      port: explicitPort ?? (serverMode ? DEFAULT_CLIENT_PORT : resolveEnvPort()),
      token: resolveToken(tokenState.token),
      tls: buildTlsOption(tlsState),
      json,
      help,
      version,
    },
    commandArgs,
  };
}
