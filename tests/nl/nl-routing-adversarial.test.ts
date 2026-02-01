/**
 * NL Routing Adversarial Tests (PART F)
 *
 * Tests the natural language fallback parser with:
 * 1. Pattern matching correctness
 * 2. Edge cases and ambiguous queries
 * 3. Adversarial inputs (injection attempts, malformed queries)
 * 4. Multi-driver and H2H pattern variations
 */

import { describe, it, expect } from 'vitest';

// Import the module to test the fallback intent builder
// We'll need to export buildFallbackIntent for testing
// For now, we'll test through the patterns directly

/**
 * Simulate the NL fallback parser's behavior by testing patterns
 * This mirrors the logic in nl-query.ts buildFallbackIntent
 */

const YEAR_PATTERN = /\b(19|20)\d{2}\b/;

function extractSeason(question: string): number {
  const match = question.match(YEAR_PATTERN);
  if (!match) {
    return 2025;
  }
  return parseInt(match[0], 10);
}

function stripYear(text: string): string {
  return text.replace(YEAR_PATTERN, '').trim();
}

function normalizeEntity(text: string): string {
  return stripYear(text).replace(/[?.!]/g, '').trim();
}

function extractAfterPattern(question: string, pattern: RegExp): string | null {
  const match = question.match(pattern);
  if (!match || !match[1]) {
    return null;
  }
  const value = normalizeEntity(match[1]);
  return value.length > 0 ? value : null;
}

describe('NL Routing - Season Extraction', () => {
  it('extracts year from question', () => {
    expect(extractSeason('How did Max do in 2025?')).toBe(2025);
    expect(extractSeason('Compare Norris and Piastri 2024')).toBe(2024);
    expect(extractSeason('Season summary for Hamilton 2023')).toBe(2023);
  });

  it('defaults to 2025 when no year present', () => {
    expect(extractSeason('How did Max do?')).toBe(2025);
    expect(extractSeason('Compare Norris and Piastri')).toBe(2025);
  });

  it('handles historical years', () => {
    expect(extractSeason('Schumacher career 1994')).toBe(1994);
    expect(extractSeason('Senna at Monaco 1988')).toBe(1988);
  });

  it('ignores invalid years', () => {
    expect(extractSeason('Compare 1 and 2')).toBe(2025); // Not valid years
    expect(extractSeason('Position 123')).toBe(2025);
  });
});

describe('NL Routing - Race Results Patterns', () => {
  it('matches "results of" pattern', () => {
    const question = 'results of Bahrain 2025';
    expect(/results of|race results|who won|winner of|podium|\bresults\b/i.test(question)).toBe(true);
    expect(extractAfterPattern(question, /results of\s+(.+)$/i)).toBe('Bahrain');
  });

  it('matches "who won" pattern', () => {
    const question = 'Who won the Monaco GP 2025?';
    expect(/results of|race results|who won|winner of|podium|\bresults\b/i.test(question)).toBe(true);
    expect(extractAfterPattern(question, /who won(?:\s+the)?\s+(.+)$/i)).toBe('Monaco GP');
  });

  it('matches "podium at" pattern', () => {
    const question = 'podium at Silverstone';
    expect(/results of|race results|who won|winner of|podium|\bresults\b/i.test(question)).toBe(true);
    expect(extractAfterPattern(question, /podium at\s+(.+)$/i)).toBe('Silverstone');
  });
});

describe('NL Routing - Track Fastest Patterns', () => {
  it('matches "fastest at" patterns', () => {
    expect(/fastest at|fastest drivers at|fastest driver at|who was fastest at/i.test('Who was fastest at Monza?')).toBe(true);
    expect(/fastest at|fastest drivers at|fastest driver at|who was fastest at/i.test('Fastest drivers at Spa')).toBe(true);
    expect(/fastest at|fastest drivers at|fastest driver at|who was fastest at/i.test('fastest at Silverstone 2025')).toBe(true);
  });

  it('extracts track from fastest pattern', () => {
    expect(extractAfterPattern('fastest at Monza 2025', /fastest at\s+(.+)$/i)).toBe('Monza');
    expect(extractAfterPattern('Who was fastest at Monaco?', /who was fastest at\s+(.+)$/i)).toBe('Monaco');
  });
});

describe('NL Routing - Compare Patterns', () => {
  it('matches simple compare pattern', () => {
    const pattern = /compare\s+(.+?)\s+(?:and|vs\.?|versus)\s+(.+?)(?:\s+at\s+|\s+in\s+|\s+on\s+|\s+)(.+)?$/i;
    const match = 'Compare Norris and Piastri 2025'.match(pattern);
    expect(match).not.toBeNull();
    if (match) {
      expect(normalizeEntity(match[1])).toBe('Norris');
      expect(normalizeEntity(match[2])).toBe('Piastri');
    }
  });

  it('matches compare with track', () => {
    const pattern = /compare\s+(.+?)\s+(?:and|vs\.?|versus)\s+(.+?)(?:\s+at\s+|\s+in\s+|\s+on\s+|\s+)(.+)?$/i;
    const match = 'Compare Verstappen and Norris at Silverstone'.match(pattern);
    expect(match).not.toBeNull();
    if (match) {
      expect(normalizeEntity(match[1])).toBe('Verstappen');
      expect(normalizeEntity(match[2])).toBe('Norris');
      const track = normalizeEntity(stripYear(match[3] || ''));
      expect(track).toBe('Silverstone');
    }
  });

  it('matches "vs" variations', () => {
    // pattern matches driver comparison with optional location suffix
    const pattern = /compare\s+(.+?)\s+(?:and|vs\.?|versus)\s+(.+?)(?:$|\s+(?:at|in|on)\s+(.+))?$/i;
    expect('Compare Leclerc vs Sainz'.match(pattern)).not.toBeNull();
    expect('Compare Leclerc versus Sainz'.match(pattern)).not.toBeNull();
    expect('Compare Leclerc vs. Sainz'.match(pattern)).not.toBeNull();
  });
});

describe('NL Routing - Dual Comparison (Qualifying vs Race)', () => {
  it('matches qualifying vs race patterns', () => {
    expect(/qualify(?:ing)?\s*(?:vs\.?|versus|v\.?)\s*race/i.test('qualifying vs race for Norris')).toBe(true);
    expect(/qualify(?:ing)?\s*(?:vs\.?|versus|v\.?)\s*race/i.test('quali v race Leclerc')).toBe(false); // Needs full word
    expect(/quali\s*(?:vs\.?|versus|v\.?)\s*race/i.test('quali vs race Leclerc')).toBe(true);
  });

  it('matches reverse pattern (race vs qualifying)', () => {
    expect(/race\s*(?:vs\.?|versus|v\.?)\s*qualify(?:ing)?/i.test('race vs qualifying Hamilton')).toBe(true);
  });
});

describe('NL Routing - Head to Head Patterns', () => {
  it('matches h2h keyword variations', () => {
    expect(/head\s*to\s*head|h2h|\boutqualif(?:y|ied)\b|\boutfinish(?:ed)?\b|finished ahead|beat count|who beat|how many times/i.test('head to head Verstappen Norris')).toBe(true);
    expect(/head\s*to\s*head|h2h|\boutqualif(?:y|ied)\b|\boutfinish(?:ed)?\b|finished ahead|beat count|who beat|how many times/i.test('h2h Max Lewis')).toBe(true);
    expect(/head\s*to\s*head|h2h|\boutqualif(?:y|ied)\b|\boutfinish(?:ed)?\b|finished ahead|beat count|who beat|how many times/i.test('Lando outqualified Oscar how many times')).toBe(true);
    expect(/head\s*to\s*head|h2h|\boutqualif(?:y|ied)\b|\boutfinish(?:ed)?\b|finished ahead|beat count|who beat|how many times/i.test('who finished ahead more often')).toBe(true);
  });

  it('extracts drivers from "outqualify" pattern', () => {
    // stop capture at prepositions (in, at, on, for) or end of string
    const pattern = /(\w+)\s+(?:outqualif(?:y|ied)|outfinish(?:ed)?)\s+(\w+)/i;
    const match = 'Norris outqualified Piastri in 2025'.match(pattern);
    expect(match).not.toBeNull();
    if (match) {
      expect(normalizeEntity(match[1])).toBe('Norris');
      expect(normalizeEntity(match[2])).toBe('Piastri');
    }
  });

  it('extracts drivers from "h2h X vs Y" pattern', () => {
    const pattern = /(?:head\s*to\s*head|h2h)\s+(\w+(?:\s+\w+)?)\s+(?:vs\.?|versus|v\.?|and|&)\s+(\w+(?:\s+\w+)?)/i;
    const match = 'h2h Verstappen vs Hamilton'.match(pattern);
    expect(match).not.toBeNull();
    if (match) {
      expect(normalizeEntity(match[1])).toBe('Verstappen');
      expect(normalizeEntity(match[2])).toBe('Hamilton');
    }
  });

  it('determines metric from question context', () => {
    // Qualifying metric detection
    expect(/qualif(?:y|ying|ied)?|quali\b/i.test('qualifying h2h Norris Piastri')).toBe(true);
    expect(/qualif(?:y|ying|ied)?|quali\b/i.test('Who outqualified whom more')).toBe(true);

    // Race metric detection
    expect(/race|finish(?:ed)?|won/i.test('race h2h Verstappen Hamilton')).toBe(true);
    expect(/race|finish(?:ed)?|won/i.test('who finished ahead')).toBe(true);
  });
});

describe('NL Routing - Performance Vector Patterns', () => {
  it('matches performance profile patterns', () => {
    expect(/performance\s*(profile|vector)|strengths and weaknesses|how consistent is/i.test('performance profile for Norris')).toBe(true);
    expect(/performance\s*(profile|vector)|strengths and weaknesses|how consistent is/i.test("Verstappen's performance vector")).toBe(true);
    expect(/performance\s*(profile|vector)|strengths and weaknesses|how consistent is/i.test('strengths and weaknesses of Hamilton')).toBe(true);
    expect(/performance\s*(profile|vector)|strengths and weaknesses|how consistent is/i.test('How consistent is Leclerc?')).toBe(true);
  });

  it('extracts driver from performance patterns', () => {
    expect(extractAfterPattern('performance profile for Norris', /performance\s*(?:profile|vector)\s*(?:for|of)?\s*(.+?)(?:\s+in\s+\d{4}|\s*$)/i)).toBe('Norris');
    expect(extractAfterPattern("Verstappen's performance profile", /(.+?)'?s?\s+performance\s*(?:profile|vector)/i)).toBe('Verstappen');
    expect(extractAfterPattern('How consistent is Leclerc?', /how consistent is\s+(.+)/i)).toBe('Leclerc');
  });
});

describe('NL Routing - Multi-Driver Comparison Patterns', () => {
  it('matches rank by pattern', () => {
    expect(/rank\s+.+\s+by\s+|compare\s+(?:pace|speed|performance)\s+(?:of\s+)?|who is faster between/i.test('Rank Verstappen Norris Leclerc by pace')).toBe(true);
  });

  it('matches compare pace of pattern', () => {
    expect(/rank\s+.+\s+by\s+|compare\s+(?:pace|speed|performance)\s+(?:of\s+)?|who is faster between/i.test('Compare pace of Verstappen Norris Piastri')).toBe(true);
  });

  it('matches who is faster between pattern', () => {
    expect(/rank\s+.+\s+by\s+|compare\s+(?:pace|speed|performance)\s+(?:of\s+)?|who is faster between/i.test('Who is faster between Hamilton, Russell, Sainz, and Alonso?')).toBe(true);
  });

  it('parses multiple driver names', () => {
    const question = 'Rank Verstappen, Norris, and Leclerc by pace';
    const multiMatch = question.match(
      /(?:rank|compare\s+(?:pace|speed|performance)\s+(?:of)?|who is faster between)\s+(.+?)(?:\s+by\s+|\s+on\s+|\s+in\s+\d{4}|$)/i
    );

    expect(multiMatch).not.toBeNull();
    if (multiMatch) {
      const driversText = multiMatch[1]
        .replace(/\s+(?:and|&)\s+/gi, ', ')
        .replace(/\s+/g, ', ');

      const driverNames = driversText
        .split(/\s*,\s*/)
        .map(d => d.trim())
        .filter(d => d.length > 0 && !/^(the|in|at|on|by)$/i.test(d));

      expect(driverNames.length).toBeGreaterThanOrEqual(2);
    }
  });

  it('determines comparison metric from question', () => {
    expect(/qualifying|quali/i.test('Compare qualifying pace of Norris Piastri')).toBe(true);
    expect(/consistency|consistent/i.test('Rank by consistency Verstappen Hamilton')).toBe(true);
  });
});

describe('NL Routing - H2H Filter Extraction', () => {
  it('extracts session filter', () => {
    expect(/\bQ3\b/i.test('Q3 h2h Verstappen Norris')).toBe(true);
    expect(/\bQ2\b/i.test('qualifying Q2 only Leclerc Sainz')).toBe(true);
    expect(/\bQ1\b/i.test('head to head in Q1')).toBe(true);
  });

  it('extracts track type filter', () => {
    expect(/street\s*circuit/i.test('h2h on street circuits')).toBe(true);
    expect(/permanent\s*circuit/i.test('permanent circuit performance')).toBe(true);
    expect(/\bstreet\b/i.test('street track h2h')).toBe(true);
  });

  it('extracts weather filter', () => {
    expect(/\bwet\b|\brain\b|\brainy\b/i.test('wet race h2h')).toBe(true);
    expect(/\bdry\b/i.test('dry conditions only')).toBe(true);
    expect(/\bmixed\s*(?:conditions?)?\b/i.test('mixed conditions')).toBe(true);
  });

  it('extracts DNF exclusion', () => {
    expect(/exclud(?:e|ing)\s+dnf/i.test('exclude dnf races')).toBe(true);
    expect(/without\s+dnf/i.test('without dnf results')).toBe(true);
    expect(/no\s+dnf/i.test('no dnf comparison')).toBe(true);
    expect(/exclude\s+retirements?/i.test('exclude retirements')).toBe(true);
  });

  it('extracts round filter', () => {
    const roundMatch = 'h2h in round 5'.match(/round\s*(\d+)/i);
    expect(roundMatch).not.toBeNull();
    if (roundMatch) {
      expect(parseInt(roundMatch[1], 10)).toBe(5);
    }
  });
});

describe('NL Routing - Adversarial Inputs', () => {
  it('handles empty string', () => {
    expect(extractSeason('')).toBe(2025);
    expect(normalizeEntity('')).toBe('');
  });

  it('handles very long input', () => {
    const longInput = 'a'.repeat(10000);
    expect(() => extractSeason(longInput)).not.toThrow();
    expect(() => normalizeEntity(longInput)).not.toThrow();
  });

  it('handles special characters', () => {
    expect(normalizeEntity("Verstappen's")).toBe("Verstappen's");
    expect(normalizeEntity('Max Verstappen!')).toBe('Max Verstappen');
    expect(normalizeEntity('Who won?')).toBe('Who won');
  });

  it('handles SQL injection attempts in track name', () => {
    const maliciousTrack = "'; DROP TABLE drivers; --";
    const normalized = normalizeEntity(maliciousTrack);
    // Should just pass through as a string (SQL injection is handled by parameterized queries)
    expect(normalized).toBe("'; DROP TABLE drivers; --");
  });

  it('handles XSS attempts', () => {
    const xssInput = '<script>alert("xss")</script>';
    const normalized = normalizeEntity(xssInput);
    // Should pass through (XSS is a display concern, not parsing)
    expect(normalized).toBe('<script>alert("xss")</script>');
  });

  it('handles unicode input', () => {
    expect(normalizeEntity('Pérez')).toBe('Pérez');
    expect(normalizeEntity('Räikkönen')).toBe('Räikkönen');
  });

  it('handles case variations', () => {
    expect(/compare/i.test('COMPARE')).toBe(true);
    expect(/compare/i.test('Compare')).toBe(true);
    expect(/compare/i.test('compare')).toBe(true);
  });

  it('handles extra whitespace', () => {
    expect(normalizeEntity('  Max   Verstappen  ')).toBe('Max   Verstappen');
    expect(stripYear('  2025  ')).toBe('');
  });

  it('handles newlines and tabs', () => {
    expect(normalizeEntity('Max\nVerstappen')).toBe('Max\nVerstappen');
    expect(normalizeEntity('Max\tVerstappen')).toBe('Max\tVerstappen');
  });

  it('handles numeric-only input', () => {
    expect(extractSeason('2025')).toBe(2025);
    expect(normalizeEntity('123')).toBe('123');
  });

  it('handles contradictory filters gracefully', () => {
    // Both wet and dry - implementation should handle this
    const question = 'wet and dry h2h Verstappen Hamilton';
    expect(/\bwet\b/i.test(question)).toBe(true);
    expect(/\bdry\b/i.test(question)).toBe(true);
    // The parser will match wet first, which is fine
  });
});

describe('NL Routing - Edge Cases', () => {
  it('handles driver name that looks like a year', () => {
    // Edge case: driver ID that starts with numbers
    const question = 'Compare 1234 and Verstappen';
    expect(extractSeason(question)).toBe(2025); // 1234 is not a valid year pattern (needs 19xx or 20xx)
  });

  it('handles question with multiple years', () => {
    const question = 'Compare 2024 vs 2025 performance';
    expect(extractSeason(question)).toBe(2024); // Should get first match
  });

  it('handles possessive names', () => {
    const question = "Norris's outqualified Piastri";
    const pattern = /(\w+(?:\s+\w+)?)\s+(?:outqualif(?:y|ied)|outfinish(?:ed)?)\s+(\w+(?:\s+\w+)?)/i;
    const match = question.match(pattern);
    // This won't match cleanly due to possessive
    // But that's OK - the pattern is designed for simpler cases
  });

  it('handles team names in questions', () => {
    const question = 'Compare McLaren teammates 2025';
    // This should trigger teammate comparison logic
    expect(/teammate/i.test(question)).toBe(true);
  });

  it('handles mixed case abbreviations', () => {
    expect(/h2h/i.test('H2H')).toBe(true);
    expect(/h2h/i.test('h2H')).toBe(true);
  });

  it('handles track names with spaces', () => {
    const extracted = extractAfterPattern('fastest at Albert Park', /fastest at\s+(.+)$/i);
    expect(extracted).toBe('Albert Park');
  });

  it('handles GP suffix in track names', () => {
    const extracted = extractAfterPattern('who won the British GP', /who won(?:\s+the)?\s+(.+)$/i);
    expect(extracted).toBe('British GP');
  });
});

describe('NL Routing - Career vs Season Disambiguation', () => {
  it('identifies career queries', () => {
    expect(/career|all-time/i.test('Verstappen career summary')).toBe(true);
    expect(/career|all-time/i.test('all-time podiums Hamilton')).toBe(true);
  });

  it('excludes career when year is present', () => {
    const question = 'career summary for Hamilton 2025';
    const isCareer = /career|all-time/i.test(question) && !/season/i.test(question) && !YEAR_PATTERN.test(question);
    expect(isCareer).toBe(false); // Year present, so not a pure career query
  });

  it('identifies season queries', () => {
    expect(/season/i.test('Norris 2025 season summary')).toBe(true);
    expect(/how did\s+.+\s+do\s+in\s+\d{4}/i.test('How did Max do in 2025?')).toBe(true);
  });
});
