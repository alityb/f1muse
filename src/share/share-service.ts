import { Pool } from 'pg';
import crypto from 'crypto';

// immutability invariants:
// - once created, answer payload is never modified
// - version field enables forward-compatible rendering
// - params are resolved identities, not raw user input
// - no recomputation on retrieval - stored answer is returned as-is
export const SCHEMA_VERSION = 1;
const MAX_ID_RETRIES = 5;

// feed display limits
const HEADLINE_MAX_LENGTH = 70;
const SUMMARY_MAX_LENGTH = 160;
const FEED_LIMIT = 10;
const TRENDING_DAYS = 7;

// ranking order toggle (code-level experiment)
export const FEED_ORDER: 'trending' | 'recent' = 'trending';

export function truncateWithEllipsis(text: string, maxLength: number): string {
  if (!text || text.length <= maxLength) {
    return text || '';
  }
  return text.slice(0, maxLength - 1).trimEnd() + '…';
}

export function formatHeadline(headline: string): string {
  return truncateWithEllipsis(headline, HEADLINE_MAX_LENGTH);
}

export function formatSummary(summary: string | null): string {
  return truncateWithEllipsis(summary || '', SUMMARY_MAX_LENGTH);
}

export interface SharedQuery {
  id: string;
  version: number;
  query_kind: string;
  params: Record<string, unknown>;
  season: number;
  answer: Record<string, unknown>;
  headline: string;
  summary: string | null;
  created_at: Date;
  expires_at: Date | null;
  view_count: number;
}

export interface CreateShareInput {
  query_kind: string;
  params: Record<string, unknown>;
  season: number;
  answer: Record<string, unknown>;
  headline: string;
  summary?: string;
  expires_at?: Date;
}

export type ShareLookupResult =
  | { found: true; expired: false; share: SharedQuery }
  | { found: true; expired: true; share: SharedQuery }
  | { found: false };

export interface ShareFeedItem {
  id: string;
  headline: string;
  summary: string;
  created_at: string;
  view_count: number;
}

export interface ShareFeed {
  recent: ShareFeedItem[];
  trending: ShareFeedItem[];
}

function generateShareId(): string {
  const bytes = crypto.randomBytes(6);
  return bytes.toString('base64url').slice(0, 8).toLowerCase();
}

export class ShareService {
  constructor(private pool: Pool) {}

  async create(input: CreateShareInput): Promise<SharedQuery> {
    const summary = input.summary || this.extractSummary(input.answer);

    // retry on id collision (unlikely but possible)
    for (let attempt = 0; attempt < MAX_ID_RETRIES; attempt++) {
      const id = generateShareId();

      try {
        const result = await this.pool.query<SharedQuery>(
          `INSERT INTO shared_queries (id, version, query_kind, params, season, answer, headline, summary, expires_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
           RETURNING *`,
          [
            id,
            SCHEMA_VERSION,
            input.query_kind,
            JSON.stringify(input.params),
            input.season,
            JSON.stringify(input.answer),
            input.headline,
            summary,
            input.expires_at || null
          ]
        );

        return this.parseRow(result.rows[0]);
      } catch (err: any) {
        const isConflict = err.code === '23505';
        if (!isConflict || attempt === MAX_ID_RETRIES - 1) {
          throw err;
        }
      }
    }

    throw new Error('failed to generate unique share id after max retries');
  }

  async lookup(id: string): Promise<ShareLookupResult> {
    const result = await this.pool.query<any>(
      `SELECT * FROM shared_queries WHERE id = $1`,
      [id]
    );

    if (result.rows.length === 0) {
      return { found: false };
    }

    const share = this.parseRow(result.rows[0]);
    const now = new Date();

    if (share.expires_at && share.expires_at < now) {
      return { found: true, expired: true, share };
    }

    return { found: true, expired: false, share };
  }

  async incrementViewCount(id: string): Promise<void> {
    await this.pool.query(
      `UPDATE shared_queries SET view_count = view_count + 1 WHERE id = $1`,
      [id]
    );
  }

  async ensureTable(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS shared_queries (
        id VARCHAR(12) PRIMARY KEY,
        version INTEGER NOT NULL DEFAULT 1,
        query_kind VARCHAR(64) NOT NULL,
        params JSONB NOT NULL,
        season INTEGER NOT NULL,
        answer JSONB NOT NULL,
        headline VARCHAR(512) NOT NULL,
        summary VARCHAR(1024),
        created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
        expires_at TIMESTAMP WITH TIME ZONE,
        view_count INTEGER NOT NULL DEFAULT 0
      )
    `);
  }

  async getFeed(): Promise<ShareFeed> {
    const [recent, trending] = await Promise.all([
      this.getRecentShares(),
      this.getTrendingShares()
    ]);
    return { recent, trending };
  }

  async getRecentShares(): Promise<ShareFeedItem[]> {
    const result = await this.pool.query<any>(
      `SELECT id, headline, summary, created_at, view_count
       FROM shared_queries
       WHERE expires_at IS NULL OR expires_at > NOW()
       ORDER BY created_at DESC
       LIMIT $1`,
      [FEED_LIMIT]
    );
    return result.rows.map(this.parseFeedItem);
  }

  async getTrendingShares(): Promise<ShareFeedItem[]> {
    const cutoff = new Date(Date.now() - TRENDING_DAYS * 24 * 60 * 60 * 1000);
    const result = await this.pool.query<any>(
      `SELECT id, headline, summary, created_at, view_count
       FROM shared_queries
       WHERE (expires_at IS NULL OR expires_at > NOW())
         AND created_at > $1
       ORDER BY view_count DESC, created_at DESC
       LIMIT $2`,
      [cutoff.toISOString(), FEED_LIMIT]
    );
    return result.rows.map(this.parseFeedItem);
  }

  private parseFeedItem(row: any): ShareFeedItem {
    return {
      id: row.id,
      headline: formatHeadline(row.headline),
      summary: formatSummary(row.summary),
      created_at: new Date(row.created_at).toISOString(),
      view_count: row.view_count
    };
  }

  private parseRow(row: any): SharedQuery {
    return {
      id: row.id,
      version: row.version,
      query_kind: row.query_kind,
      params: typeof row.params === 'string' ? JSON.parse(row.params) : row.params,
      season: row.season,
      answer: typeof row.answer === 'string' ? JSON.parse(row.answer) : row.answer,
      headline: row.headline,
      summary: row.summary,
      created_at: new Date(row.created_at),
      expires_at: row.expires_at ? new Date(row.expires_at) : null,
      view_count: row.view_count
    };
  }

  private extractSummary(answer: Record<string, unknown>): string | null {
    // extract first bullet or coverage summary
    const bullets = answer.bullets as string[] | undefined;
    if (bullets && bullets.length > 0) {
      return bullets[0].slice(0, 200);
    }
    const coverage = answer.coverage as { summary?: string } | undefined;
    if (coverage?.summary) {
      return coverage.summary.slice(0, 200);
    }
    return null;
  }
}
