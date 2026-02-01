import { describe, it, expect } from 'vitest';
import { normalizeCanonical } from '../src/llm/intent-cache';

describe('normalizeCanonical', () => {
  it('lowercases and trims', () => {
    expect(normalizeCanonical('  HELLO WORLD  ')).toBe('hello world');
  });

  it('removes punctuation', () => {
    expect(normalizeCanonical('who won monaco 2025?')).toBe('won monaco 2025');
    // apostrophe removed, possessive 's' filtered as stopword
    expect(normalizeCanonical("verstappen's pace")).toBe('verstappen pace');
  });

  it('removes stopwords', () => {
    expect(normalizeCanonical('who is the fastest driver')).toBe('fastest driver');
    expect(normalizeCanonical('show me the results of monaco')).toBe('results monaco');
  });

  it('preserves numbers', () => {
    expect(normalizeCanonical('season 2025')).toBe('season 2025');
    expect(normalizeCanonical('round 5 results')).toBe('round 5 results');
  });

  it('preserves driver names', () => {
    expect(normalizeCanonical('compare verstappen and norris')).toBe('compare verstappen norris');
    expect(normalizeCanonical('hamilton vs leclerc at monaco')).toBe('hamilton vs leclerc monaco');
  });

  it('collapses whitespace', () => {
    expect(normalizeCanonical('verstappen    norris   2025')).toBe('verstappen norris 2025');
  });

  it('handles compound words with hyphens', () => {
    expect(normalizeCanonical('head-to-head comparison')).toBe('head-to-head comparison');
  });

  it('handles empty and whitespace-only input', () => {
    expect(normalizeCanonical('')).toBe('');
    expect(normalizeCanonical('   ')).toBe('');
  });

  it('handles questions that become identical after normalization', () => {
    const q1 = normalizeCanonical('Who was fastest at Monaco in 2025?');
    const q2 = normalizeCanonical('fastest at monaco 2025');
    expect(q1).toBe(q2);
  });

  it('handles semantic variations', () => {
    const q1 = normalizeCanonical('Show me the results of Silverstone 2025');
    const q2 = normalizeCanonical('results silverstone 2025');
    expect(q1).toBe(q2);
  });
});
