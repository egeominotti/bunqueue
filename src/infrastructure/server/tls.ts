/**
 * Server TLS options
 * Shared by the TCP (Bun.listen) and HTTP (Bun.serve) servers.
 */

import { X509Certificate } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { createSecureContext } from 'node:tls';

/** TLS configuration for a server (paths to PEM files) */
export interface TlsServerOptions {
  /** Path to the PEM certificate (or full chain) file */
  certFile: string;
  /** Path to the PEM private key file */
  keyFile: string;
}

/**
 * The PEM bytes a listener serves. Held as bytes, not `Bun.file` handles, so a listener
 * that must rebind (the HTTP unix socket on a failed reload) serves exactly what it
 * served before, whatever is on disk by then.
 */
export interface TlsMaterial {
  cert: Buffer;
  key: Buffer;
}

/** What a reload log line reports about the certificate now served. */
export interface TlsCertificateInfo {
  subject: string;
  /** Expiry (`validTo`) as an ISO-8601 string. */
  notAfter: string;
  /** SHA-256 fingerprint, colon-separated hex (as `getPeerCertificate()` reports it). */
  fingerprint256: string;
}

/**
 * Validate cert/key paths and read both files for Bun.listen/Bun.serve. Fails fast with
 * a descriptive error so a typo in a path surfaces at startup (or on a reload) instead
 * of as an opaque handshake failure.
 */
export function readTlsMaterial(tls: TlsServerOptions): TlsMaterial {
  if (!existsSync(tls.certFile)) {
    throw new Error(`TLS cert file not found: ${tls.certFile}`);
  }
  if (!existsSync(tls.keyFile)) {
    throw new Error(`TLS key file not found: ${tls.keyFile}`);
  }
  return { cert: readFileSync(tls.certFile), key: readFileSync(tls.keyFile) };
}

/**
 * Throw when the pair cannot be served (garbage PEM, empty file, a key that does not
 * match the certificate) without binding anything: the same OpenSSL checks a listener
 * runs, so a reload refuses a bad pair before any listener is touched.
 */
export function validateTlsMaterial(material: TlsMaterial): void {
  createSecureContext({ cert: material.cert, key: material.key });
}

/** Subject, expiry and fingerprint of the leaf (first) certificate in `cert`. */
export function describeCertificate(cert: Buffer): TlsCertificateInfo {
  const x509 = new X509Certificate(cert);
  return {
    subject: x509.subject,
    notAfter: x509.validToDate.toISOString(),
    fingerprint256: x509.fingerprint256,
  };
}
