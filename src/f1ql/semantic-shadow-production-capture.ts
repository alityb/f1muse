import {
  createPrivateKey,
  createPublicKey,
  KeyObject,
  sign,
  verify
} from 'node:crypto';
import {
  sanitizeSemanticShadowRetainedObservation,
  SemanticShadowRetainedObservation
} from './semantic-shadow-retained-observation';

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u;
const SIGNATURE = /^[A-Za-z0-9+/]{86}==$/u;

export interface SemanticShadowProductionCaptureSigner {
  readonly key_id: string;
  readonly private_key: KeyObject;
}

export interface TrustedSemanticShadowProductionCaptureKey {
  readonly key_id: string;
  readonly public_key: KeyObject;
}

export function loadSemanticShadowProductionCapturePrivateKey(value: string): KeyObject {
  return loadKey(value, 'private');
}

export function loadSemanticShadowProductionCapturePublicKey(value: string): KeyObject {
  return loadKey(value, 'public');
}

export function attachSemanticShadowProductionCapture(
  input: unknown,
  signer: SemanticShadowProductionCaptureSigner
): SemanticShadowRetainedObservation {
  assertSigner(signer);
  const retained = sanitizeSemanticShadowRetainedObservation(input);
  if (!('production_evidence_binding' in retained) || retained.production_evidence_binding === undefined ||
      retained.production_capture !== undefined) {
    throw new Error('semantic shadow production capture input is invalid');
  }
  const productionCapture = {
    key_id: signer.key_id,
    algorithm: 'Ed25519' as const,
    signature: sign(null, capturePayload(retained), signer.private_key).toString('base64')
  };
  return sanitizeSemanticShadowRetainedObservation({ ...retained, production_capture: productionCapture });
}

export function verifySemanticShadowProductionCapture(
  input: unknown,
  trustedKey: TrustedSemanticShadowProductionCaptureKey
): SemanticShadowRetainedObservation {
  assertTrustedKey(trustedKey);
  const retained = sanitizeSemanticShadowRetainedObservation(input);
  if (!('production_evidence_binding' in retained) || retained.production_evidence_binding === undefined ||
      retained.production_capture?.key_id !== trustedKey.key_id ||
      retained.production_capture.algorithm !== 'Ed25519' ||
      !SIGNATURE.test(retained.production_capture.signature)) {
    throw new Error('semantic shadow production capture is invalid');
  }
  const { production_capture: productionCapture, ...unsigned } = retained;
  const signature = Buffer.from(productionCapture.signature, 'base64');
  if (signature.byteLength !== 64 || signature.toString('base64') !== productionCapture.signature ||
      !verify(null, capturePayload(unsigned), trustedKey.public_key, signature)) {
    throw new Error('semantic shadow production capture signature mismatch');
  }
  return retained;
}

function loadKey(value: string, type: 'private' | 'public'): KeyObject {
  try {
    const decoded = Buffer.from(value, 'base64');
    if (decoded.toString('base64') !== value || decoded.byteLength < 32 || decoded.byteLength > 4_096) {
      throw new Error('invalid');
    }
    const key = type === 'private'
      ? createPrivateKey({ key: decoded, format: 'der', type: 'pkcs8' })
      : createPublicKey({ key: decoded, format: 'der', type: 'spki' });
    if (key.type !== type || key.asymmetricKeyType !== 'ed25519') {throw new Error('invalid');}
    return key;
  } catch {
    throw new Error('semantic shadow production capture key is invalid');
  }
}

function assertSigner(signer: SemanticShadowProductionCaptureSigner): void {
  if (!IDENTIFIER.test(signer.key_id) || signer.private_key.type !== 'private' ||
      signer.private_key.asymmetricKeyType !== 'ed25519') {
    throw new Error('semantic shadow production capture key is invalid');
  }
}

function assertTrustedKey(key: TrustedSemanticShadowProductionCaptureKey): void {
  if (!IDENTIFIER.test(key.key_id) || key.public_key.type !== 'public' ||
      key.public_key.asymmetricKeyType !== 'ed25519') {
    throw new Error('semantic shadow production capture key is invalid');
  }
}

function capturePayload(input: unknown): Buffer {
  return Buffer.from(`semantic-shadow-production-capture-v1\n${stableSerialize(input)}`, 'utf8');
}

function stableSerialize(value: unknown): string {
  if (Array.isArray(value)) {return `[${value.map(stableSerialize).join(',')}]`;}
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) => compareText(left, right));
    return `{${entries.map(([key, child]) => `${JSON.stringify(key)}:${stableSerialize(child)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function compareText(left: string, right: string): number {
  if (left < right) {return -1;}
  return left > right ? 1 : 0;
}
