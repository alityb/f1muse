import { createHash } from 'node:crypto';
import { PoolConfig } from 'pg';

const MAXIMUM_CA_BYTES = 64 * 1024;
const SSL_QUERY_PARAMETERS = new Set(['ssl', 'sslmode', 'sslcert', 'sslkey', 'sslrootcert', 'sslpassword']);

export interface AnswerDatabaseConnectionIdentity {
  readonly target_sha256: string;
  readonly current_user_sha256: string;
  readonly current_database_sha256: string;
}

export function computeAnswerDatabaseConnectionIdentity(
  connectionString: string | undefined
): AnswerDatabaseConnectionIdentity {
  try {
    if (!connectionString) {throw new Error('invalid');}
    const url = new URL(connectionString);
    stripSslParameters(url);
    if ((url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') || !url.hostname ||
        !url.port || !url.username || url.pathname.length < 2 || url.searchParams.size > 0 || url.hash) {
      throw new Error('invalid');
    }
    const username = decodeURIComponent(url.username);
    const database = decodeURIComponent(url.pathname.slice(1));
    if (!username || !database || username.includes('\0') || database.includes('\0')) {throw new Error('invalid');}
    const target = [
      'f1ql-answer-database-target-v1',
      url.hostname.toLowerCase(),
      url.port,
      url.pathname
    ].join('\n');
    return Object.freeze({
      target_sha256: createHash('sha256').update(target, 'utf8').digest('hex'),
      current_user_sha256: createHash('sha256').update(username, 'utf8').digest('hex'),
      current_database_sha256: createHash('sha256').update(database, 'utf8').digest('hex')
    });
  } catch {
    throw new Error('answer_database_target_invalid');
  }
}

export function computeAnswerDatabaseTargetSha256(connectionString: string | undefined): string {
  return computeAnswerDatabaseConnectionIdentity(connectionString).target_sha256;
}

export function buildAnswerDatabasePoolConfig(
  connectionString: string | undefined,
  caCertificateBase64: string | undefined
): PoolConfig {
  if (!connectionString || !caCertificateBase64) {
    throw new Error('answer_database_tls_not_configured');
  }
  try {
    const url = new URL(connectionString);
    if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') {
      throw new Error('invalid');
    }
    stripSslParameters(url);
    if (url.searchParams.size > 0 || url.hash) {throw new Error('invalid');}
    computeAnswerDatabaseConnectionIdentity(url.toString());
    const ca = Buffer.from(caCertificateBase64, 'base64');
    if (ca.byteLength < 1 || ca.byteLength > MAXIMUM_CA_BYTES || ca.toString('base64') !== caCertificateBase64) {
      throw new Error('invalid');
    }
    const certificate = ca.toString('utf8');
    if (!certificate.includes('-----BEGIN CERTIFICATE-----') || !certificate.includes('-----END CERTIFICATE-----') || certificate.includes('\0')) {
      throw new Error('invalid');
    }
    return {
      connectionString: url.toString(),
      ssl: { ca: certificate, rejectUnauthorized: true }
    };
  } catch {
    throw new Error('answer_database_tls_configuration_invalid');
  }
}

function stripSslParameters(url: URL): void {
  for (const key of [...url.searchParams.keys()]) {
    if (SSL_QUERY_PARAMETERS.has(key.toLowerCase())) {url.searchParams.delete(key);}
  }
}
