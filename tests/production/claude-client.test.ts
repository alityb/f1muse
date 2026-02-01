import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ClaudeClient, getClaudeClient, resetClaudeClient } from '../../src/llm/claude-client';

/**
 * Claude Client Tests
 *
 * Tests for production Claude LLM client
 */

// Mock the Anthropic SDK - factory is hoisted so class must be defined inline
const mockCreate = vi.fn();

vi.mock('@anthropic-ai/sdk', () => {
  // Define class inside factory to avoid hoisting issues
  return {
    default: class MockAnthropic {
      messages = {
        create: (...args: any[]) => mockCreate(...args),
      };
    },
  };
});

describe('ClaudeClient', () => {
  beforeEach(() => {
    resetClaudeClient();
    mockCreate.mockReset();
  });

  afterEach(() => {
    resetClaudeClient();
  });

  describe('initialization', () => {
    it('should throw error if API key is not set', () => {
      const originalKey = process.env.ANTHROPIC_API_KEY;
      delete process.env.ANTHROPIC_API_KEY;
      delete process.env.CLAUDE_API_KEY;

      expect(() => new ClaudeClient()).toThrow('Claude API key not configured');

      process.env.ANTHROPIC_API_KEY = originalKey;
    });

    it('should accept API key from options', () => {
      const client = new ClaudeClient({ apiKey: 'test-key' });
      expect(client).toBeDefined();
    });

    it('should use ANTHROPIC_API_KEY from environment', () => {
      process.env.ANTHROPIC_API_KEY = 'test-key';
      const client = new ClaudeClient();
      expect(client).toBeDefined();
    });

    it('should use CLAUDE_API_KEY from environment', () => {
      const originalKey = process.env.ANTHROPIC_API_KEY;
      delete process.env.ANTHROPIC_API_KEY;
      process.env.CLAUDE_API_KEY = 'test-key';

      const client = new ClaudeClient();
      expect(client).toBeDefined();

      delete process.env.CLAUDE_API_KEY;
      process.env.ANTHROPIC_API_KEY = originalKey;
    });
  });

  describe('getClaudeClient singleton', () => {
    it('should return same instance', () => {
      process.env.ANTHROPIC_API_KEY = 'test-key';
      const client1 = getClaudeClient();
      const client2 = getClaudeClient();
      expect(client1).toBe(client2);
    });

    it('should reset instance correctly', () => {
      process.env.ANTHROPIC_API_KEY = 'test-key';
      const client1 = getClaudeClient();
      resetClaudeClient();
      const client2 = getClaudeClient();
      expect(client1).not.toBe(client2);
    });
  });
});

describe('ClaudeClient.parseIntent', () => {
  let client: ClaudeClient;

  beforeEach(() => {
    process.env.ANTHROPIC_API_KEY = 'test-key';
    client = new ClaudeClient();
    mockCreate.mockReset();
  });

  it('should parse valid race results query', async () => {
    mockCreate.mockResolvedValueOnce({
      content: [{
        type: 'text',
        text: JSON.stringify({
          kind: 'race_results_summary',
          track_id: 'monza',
          season: 2024,
        }),
      }],
    });

    const result = await client.parseIntent('Results of Monza 2024');

    expect(result.success).toBe(true);
    expect(result.intent?.kind).toBe('race_results_summary');
    expect(result.intent?.track_id).toBe('monza');
    expect(result.intent?.season).toBe(2024);
  });

  it('should handle JSON in markdown code blocks', async () => {
    mockCreate.mockResolvedValueOnce({
      content: [{
        type: 'text',
        text: '```json\n{"kind": "driver_season_summary", "driver_id": "verstappen", "season": 2024}\n```',
      }],
    });

    const result = await client.parseIntent('Verstappen 2024 season');

    expect(result.success).toBe(true);
    expect(result.intent?.kind).toBe('driver_season_summary');
  });

  it('should handle invalid JSON', async () => {
    mockCreate.mockResolvedValueOnce({
      content: [{
        type: 'text',
        text: 'This is not valid JSON',
      }],
    });

    const result = await client.parseIntent('Some query');

    expect(result.success).toBe(false);
    expect(result.error).toContain('Invalid JSON');
  });

  it('should validate query kind', async () => {
    mockCreate.mockResolvedValueOnce({
      content: [{
        type: 'text',
        text: JSON.stringify({
          kind: 'invalid_query_kind',
          season: 2024,
        }),
      }],
    });

    const result = await client.parseIntent('Some query');

    expect(result.success).toBe(false);
    expect(result.error).toContain('Invalid query kind');
  });

  it('should default season to 2025 if not provided', async () => {
    mockCreate.mockResolvedValueOnce({
      content: [{
        type: 'text',
        text: JSON.stringify({
          kind: 'driver_career_summary',
          driver_id: 'hamilton',
        }),
      }],
    });

    const result = await client.parseIntent('Hamilton career');

    expect(result.success).toBe(true);
    expect(result.intent?.season).toBe(2025);
  });

  it('should include raw_query in result', async () => {
    mockCreate.mockResolvedValueOnce({
      content: [{
        type: 'text',
        text: JSON.stringify({
          kind: 'driver_season_summary',
          driver_id: 'norris',
          season: 2024,
        }),
      }],
    });

    const result = await client.parseIntent('Norris 2024 stats');

    expect(result.success).toBe(true);
    expect(result.intent?.raw_query).toBe('Norris 2024 stats');
  });

  it('should record latency in result', async () => {
    mockCreate.mockResolvedValueOnce({
      content: [{
        type: 'text',
        text: JSON.stringify({
          kind: 'driver_season_summary',
          driver_id: 'verstappen',
          season: 2024,
        }),
      }],
    });

    const result = await client.parseIntent('Verstappen 2024');

    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });
});

describe('ClaudeClient retry behavior', () => {
  let client: ClaudeClient;

  beforeEach(() => {
    process.env.ANTHROPIC_API_KEY = 'test-key';
    mockCreate.mockReset();
  });

  it('should retry on 429 rate limit', async () => {
    const rateLimitError = new Error('Rate limited');
    (rateLimitError as any).status = 429;

    const successResponse = {
      content: [{
        type: 'text',
        text: JSON.stringify({ kind: 'driver_season_summary', driver_id: 'test', season: 2024 }),
      }],
    };

    let callCount = 0;
    mockCreate.mockImplementation(() => {
      callCount++;
      if (callCount < 2) {
        return Promise.reject(rateLimitError);
      }
      return Promise.resolve(successResponse);
    });

    client = new ClaudeClient({ apiKey: 'test' });
    const result = await client.parseIntent('Test query');

    expect(result.success).toBe(true);
    expect(result.retryCount).toBe(1);
  });

  it('should retry on 5xx server errors', async () => {
    const serverError = new Error('Server error');
    (serverError as any).status = 500;

    const successResponse = {
      content: [{
        type: 'text',
        text: JSON.stringify({ kind: 'driver_season_summary', driver_id: 'test', season: 2024 }),
      }],
    };

    let callCount = 0;
    mockCreate.mockImplementation(() => {
      callCount++;
      if (callCount < 2) {
        return Promise.reject(serverError);
      }
      return Promise.resolve(successResponse);
    });

    client = new ClaudeClient({ apiKey: 'test' });
    const result = await client.parseIntent('Test query');

    expect(result.success).toBe(true);
  });

  it('should not retry on 400 client errors', async () => {
    const clientError = new Error('Bad request');
    (clientError as any).status = 400;

    mockCreate.mockRejectedValue(clientError);

    client = new ClaudeClient({ apiKey: 'test' });
    const result = await client.parseIntent('Test query');

    expect(result.success).toBe(false);
    expect(result.retryCount).toBe(0);
  });
});
