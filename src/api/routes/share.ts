import { Router, Request, Response } from 'express';
import { Pool } from 'pg';
import { ShareService, SharedQuery, FEED_ORDER } from '../../share/share-service';

const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';
const HTML_CACHE_MAX_AGE = 3600;
const FEED_CACHE_MAX_AGE = 30;

export function createShareRoutes(pool: Pool): Router {
  const router = Router();
  const shareService = new ShareService(pool);

  // ensure table exists on startup (non-blocking)
  let tableReady = false;
  shareService.ensureTable()
    .then(() => {
      tableReady = true;
      console.log('[Share] Table ready');
    })
    .catch((err) => {
      console.warn('[Share] Table setup failed - share features disabled:', err.message);
    });

  // middleware to check if share is available
  const requireTable = (_req: Request, res: Response, next: () => void): void => {
    if (!tableReady) {
      res.status(503).json({
        error: 'share_unavailable',
        reason: 'Share feature is initializing or unavailable'
      });
      return;
    }
    next();
  };

  // read-only feed endpoint (no llm, no sql templates)
  router.get('/share-feed', requireTable, async (_req: Request, res: Response) => {
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

  // retrieve shared result (no llm, no sql execution - answer is immutable)
  router.get('/share/:id', requireTable, async (req: Request, res: Response) => {
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
