import { Router, Request, Response } from 'express';
import { Pool } from 'pg';
import { QueryExecutor } from '../../execution/query-executor';
import { ShareService, SharedQuery, FEED_ORDER } from '../../share/share-service';
import { buildInterpretationResponse } from '../../presentation/interpretation-builder';
import { QueryIntent } from '../../types/query-intent';
import { shareRateLimiter } from '../../middleware/rate-limiter';

const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';
const HTML_CACHE_MAX_AGE = 3600;
const FEED_CACHE_MAX_AGE = 30;

export function createShareRoutes(pool: Pool, executor: QueryExecutor, cachePool?: Pool): Router {
  const router = Router();
  const writePool = cachePool || pool;
  const shareService = new ShareService(writePool);

  // read-only feed endpoint (no llm, no sql templates)
  router.get('/share-feed', async (_req: Request, res: Response) => {
    try {
      const feed = await shareService.getFeed();

      res.setHeader('Cache-Control', `public, max-age=${FEED_CACHE_MAX_AGE}`);
      return res.status(200).json({
        order: FEED_ORDER,
        trending: feed.trending,
        recent: feed.recent
      });
    } catch (err) {
      console.error('[Share] Feed error:', err);
      return res.status(500).json({
        error: 'feed_failed',
        reason: err instanceof Error ? err.message : 'Unknown error'
      });
    }
  });

  router.post('/share', shareRateLimiter.middleware(), async (req: Request, res: Response) => {
    try {
      const intent = req.body as QueryIntent;

      if (!intent.kind) {
        return res.status(400).json({
          error: 'invalid_input',
          reason: 'query_kind is required'
        });
      }

      // execute query to get resolved answer
      const interpretation = await buildInterpretationResponse({
        pool,
        executor,
        intent
      });

      if ('error' in interpretation.result) {
        return res.status(400).json({
          error: 'query_failed',
          reason: interpretation.result.reason,
          answer: interpretation.answer
        });
      }

      // extract headline and summary from answer
      const headline = interpretation.answer.headline || `${intent.kind} result`;
      const summary = interpretation.answer.bullets?.[0] ||
                      interpretation.answer.coverage?.summary ||
                      null;

      // store resolved answer
      const share = await shareService.create({
        query_kind: intent.kind,
        params: extractParams(intent),
        season: intent.season,
        answer: {
          query_kind: interpretation.answer.query_kind,
          headline: interpretation.answer.headline,
          bullets: interpretation.answer.bullets,
          coverage: interpretation.answer.coverage,
          followups: interpretation.answer.followups
        },
        headline,
        summary: summary || undefined
      });

      return res.status(201).json({
        share_id: share.id,
        url: `${BASE_URL}/share/${share.id}`,
        headline: share.headline,
        created_at: share.created_at.toISOString()
      });
    } catch (err) {
      console.error('[Share] Create error:', err);
      return res.status(500).json({
        error: 'share_failed',
        reason: err instanceof Error ? err.message : 'Unknown error'
      });
    }
  });

  // retrieve shared result (no llm, no sql execution - answer is immutable)
  router.get('/share/:id', async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const wantsJson = req.accepts(['json', 'html']) === 'json';

      const result = await shareService.lookup(id);

      if (!result.found) {
        if (wantsJson) {
          return res.status(404).json({
            error: 'not_found',
            reason: 'Shared result not found'
          });
        }
        return res.status(404).send(renderErrorPage('Not Found', 'This shared result does not exist.'));
      }

      if (result.expired) {
        if (wantsJson) {
          return res.status(410).json({
            error: 'expired',
            reason: 'Shared result has expired',
            expired_at: result.share.expires_at?.toISOString()
          });
        }
        return res.status(410).send(renderErrorPage('Expired', 'This shared result has expired.'));
      }

      // increment view count async (don't wait)
      shareService.incrementViewCount(id).catch(() => {});

      // json response for api consumers (explicit accept: application/json)
      if (wantsJson) {
        return res.status(200).json({
          share_id: result.share.id,
          version: result.share.version,
          query_kind: result.share.query_kind,
          params: result.share.params,
          season: result.share.season,
          answer: result.share.answer,
          headline: result.share.headline,
          summary: result.share.summary,
          created_at: result.share.created_at.toISOString(),
          view_count: result.share.view_count + 1
        });
      }

      // html response is default (browsers, crawlers, social previews)
      res.setHeader('Cache-Control', `public, max-age=${HTML_CACHE_MAX_AGE}`);
      return res.status(200).send(renderSharePage(result.share));
    } catch (err) {
      console.error('[Share] Lookup error:', err);
      return res.status(500).json({
        error: 'lookup_failed',
        reason: err instanceof Error ? err.message : 'Unknown error'
      });
    }
  });

  return router;
}

function extractParams(intent: QueryIntent): Record<string, unknown> {
  const params = { ...intent } as Record<string, unknown>;
  delete params.kind;
  delete params.raw_query;
  return params;
}

// schema-version renderer: routes to version-specific render logic
function renderSharePage(share: SharedQuery): string {
  switch (share.version) {
    case 1:
      return renderV1(share);
    default:
      // forward-compatible: unknown versions fall back to v1
      return renderV1(share);
  }
}

// v1 renderer - passthrough of stored answer structure
function renderV1(share: SharedQuery): string {
  const title = escapeHtml(share.headline);
  const description = escapeHtml(share.summary || '');
  const url = `${BASE_URL}/share/${share.id}`;

  const bullets = (share.answer as any).bullets || [];
  const bulletHtml = bullets.length > 0
    ? `<ul>${bullets.map((b: string) => `<li>${escapeHtml(b)}</li>`).join('')}</ul>`
    : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title} | F1 Muse</title>
  <meta name="description" content="${description}">
  <meta property="og:type" content="website">
  <meta property="og:title" content="${title}">
  <meta property="og:description" content="${description}">
  <meta property="og:url" content="${url}">
  <meta property="og:site_name" content="F1 Muse">
  <meta name="twitter:card" content="summary">
  <meta name="twitter:title" content="${title}">
  <meta name="twitter:description" content="${description}">
  <style>
    body { font-family: system-ui, sans-serif; max-width: 640px; margin: 2rem auto; padding: 0 1rem; line-height: 1.6; }
    h1 { font-size: 1.5rem; margin-bottom: 0.5rem; }
    .meta { color: #666; font-size: 0.875rem; margin-bottom: 1.5rem; }
    ul { padding-left: 1.25rem; }
    li { margin-bottom: 0.5rem; }
    .footer { margin-top: 2rem; padding-top: 1rem; border-top: 1px solid #eee; font-size: 0.75rem; color: #999; }
  </style>
</head>
<body>
  <h1>${title}</h1>
  <p class="meta">${share.query_kind} &middot; ${share.season} season &middot; ${share.view_count + 1} views</p>
  ${bulletHtml}
  <div class="footer">
    Shared via F1 Muse &middot; Created ${share.created_at.toISOString().split('T')[0]}
  </div>
</body>
</html>`;
}

function renderErrorPage(title: string, message: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title} | F1 Muse</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 640px; margin: 4rem auto; padding: 0 1rem; text-align: center; }
    h1 { font-size: 1.5rem; margin-bottom: 1rem; }
    p { color: #666; }
  </style>
</head>
<body>
  <h1>${title}</h1>
  <p>${message}</p>
</body>
</html>`;
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
