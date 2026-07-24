import { PoolConfig } from 'pg';

const MAXIMUM_CA_BYTES = 64 * 1024;
const SSL_QUERY_PARAMETERS = new Set(['ssl', 'sslmode', 'sslcert', 'sslkey', 'sslrootcert', 'sslpassword']);

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
    for (const key of [...url.searchParams.keys()]) {
      if (SSL_QUERY_PARAMETERS.has(key.toLowerCase())) {
        url.searchParams.delete(key);
      }
    }
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
