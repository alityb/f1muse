import { timingSafeEqual } from 'crypto';
import { NextFunction, Request, Response } from 'express';

/** Protect operational endpoints without exposing them to public API callers. */
export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  const expected = process.env.ADMIN_API_KEY;
  const authorization = req.get('authorization');
  const provided = authorization?.replace(/^Bearer\s+/i, '');

  if (!expected) {
    res.status(503).json({ error: 'admin_auth_not_configured' });
    return;
  }

  if (!provided || !safeEqual(provided, expected)) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }

  next();
}

function safeEqual(provided: string, expected: string): boolean {
  const providedBuffer = Buffer.from(provided);
  const expectedBuffer = Buffer.from(expected);

  return providedBuffer.length === expectedBuffer.length && timingSafeEqual(providedBuffer, expectedBuffer);
}
