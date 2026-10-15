import { ConfigError, parseWholeEnv } from '../../config/numbers';
import { SETTINGS } from '../../config/settings';
import { emitLocalOutput } from '../localOutput';
import { withoutOptionTerminator } from './types';

/**
 * The port the server's HTTP_PORT selects, read with the server's own setting (name,
 * default, digits only, trimmed): a value the server accepts is never a broken probe
 * URL. The probe must reach a real port, so 0 (OS-assigned) is refused.
 */
function probePort(): number {
  const { env, fallback, rule } = SETTINGS.httpPort;
  const name = env[0];
  try {
    return parseWholeEnv(name, Bun.env[name], fallback, { ...rule, min: 1 });
  } catch (error) {
    throw new ConfigError([(error as Error).message]);
  }
}

/** Shell-free HTTP probe for container health checks. Never starts a broker. */
export async function runHealthcheck(args: string[], json = false): Promise<number> {
  try {
    args = withoutOptionTerminator(args);
    if (args.length > 1) throw new Error('Expected at most one health URL');
    const url = new URL(args[0] ?? `http://127.0.0.1:${probePort()}/health`);
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Expected HTTP or HTTPS');
    const response = await fetch(url, {
      signal: AbortSignal.timeout(5000),
      redirect: 'error',
    });
    const body: unknown = await response.json();
    if (
      !response.ok ||
      typeof body !== 'object' ||
      body === null ||
      !('status' in body) ||
      body.status !== 'healthy'
    ) {
      throw new Error('Unhealthy response');
    }
    emitLocalOutput({ exitCode: 0, json: { ok: true, status: 'healthy' }, text: 'healthy' }, json);
    return 0;
  } catch (error) {
    // Avoid putting credentials or response payloads in Docker health logs; only a
    // configuration error (the operator's own setting) is worth naming.
    emitLocalOutput(
      {
        exitCode: 1,
        json: { ok: false, error: 'Health check failed' },
        text:
          error instanceof ConfigError
            ? `Health check failed: ${error.message}`
            : 'Health check failed',
        stream: 'stderr',
      },
      json
    );
    return 1;
  }
}
