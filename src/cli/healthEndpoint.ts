/** Format a health probe authority, accepting bare and already bracketed IPv6 hosts. */
export function healthEndpoint(host: string, port: number): string {
  const hostname = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
  return `${hostname}:${port}`;
}
