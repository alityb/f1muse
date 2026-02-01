import { Router, Request, Response } from 'express';
import { CAPABILITIES_DATA, SUGGESTIONS_DATA } from './capabilities-data';

export function createCapabilitiesRoutes(): Router {
  const router = Router();

  router.get('/capabilities', (_req: Request, res: Response) => {
    return res.status(200).json({
      ...CAPABILITIES_DATA,
      system_info: {
        ...CAPABILITIES_DATA.system_info,
        last_updated: new Date().toISOString().split('T')[0]
      }
    });
  });

  router.get('/suggestions', (_req: Request, res: Response) => {
    return res.status(200).json({
      ...SUGGESTIONS_DATA,
      metadata: {
        ...SUGGESTIONS_DATA.metadata,
        last_updated: new Date().toISOString().split('T')[0]
      }
    });
  });

  return router;
}
