import { describe, expect, it } from 'vitest';
import { buildAnswerDatabasePoolConfig } from '../../src/db/answer-database';

const certificate = '-----BEGIN CERTIFICATE-----\ntest-ca\n-----END CERTIFICATE-----\n';
const encodedCertificate = Buffer.from(certificate).toString('base64');

describe('answer database TLS configuration', () => {
  it('requires a canonical base64 trusted CA and enables certificate verification', () => {
    const config = buildAnswerDatabasePoolConfig('postgresql://user:password@db.example:5432/f1', encodedCertificate);
    expect(config.ssl).toEqual({ ca: certificate, rejectUnauthorized: true });
    expect(config.connectionString).not.toContain(certificate);
    expect(() => buildAnswerDatabasePoolConfig('postgresql://db.example/f1', undefined)).toThrow('not_configured');
    expect(() => buildAnswerDatabasePoolConfig('postgresql://db.example/f1', 'not-base64')).toThrow('configuration_invalid');
  });

  it('removes URL TLS parameters and rejects every remaining connection override', () => {
    const config = buildAnswerDatabasePoolConfig(
      'postgresql://user@db.example:5432/f1?ssl=false&sslmode=disable&sslrootcert=attacker',
      encodedCertificate
    );
    const url = new URL(config.connectionString as string);
    expect(url.searchParams.has('sslmode')).toBe(false);
    expect(url.searchParams.has('ssl')).toBe(false);
    expect(url.searchParams.has('sslrootcert')).toBe(false);
    expect(JSON.stringify(config)).not.toContain(encodedCertificate);
    expect(() => buildAnswerDatabasePoolConfig(
      'postgresql://user@db.example:5432/f1?application_name=answer', encodedCertificate
    )).toThrow('configuration_invalid');
    expect(() => buildAnswerDatabasePoolConfig(
      'postgresql://user@db.example/f1', encodedCertificate
    )).toThrow('configuration_invalid');
  });
});
