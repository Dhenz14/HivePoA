/**
 * gpu-api.ts — Express routes for GPU contribution management
 *
 * Mounted on the Desktop Agent's existing Express server at /api/gpu/*.
 * Provides endpoints for:
 *   - Dependency checking
 *   - Start/stop/pause/resume contribution
 *   - Real-time GPU metrics
 *   - Earnings and status
 *   - Configuration updates
 *
 * These endpoints are called by:
 *   - The browser UI (gpu-dashboard.tsx, community-cloud.tsx)
 *   - The system tray menu actions
 */

import { Router, Request, Response } from 'express';
import { GpuContributionManager, GpuContributionConfig } from './gpu-contribution';
import { NvidiaMonitor } from './nvidia-monitor';

export function createGpuRoutes(manager: GpuContributionManager): Router {
  const router = Router();
  const nvidia = new NvidiaMonitor();

  /**
   * GET /api/gpu/deps — Check all dependencies for GPU contribution.
   * Returns cached result (30s TTL).
   */
  router.get('/deps', async (_req: Request, res: Response) => {
    try {
      const deps = await nvidia.checkDependencies();
      const allOk = deps.nvidia.ok && deps.docker.ok && deps.toolkit.ok;
      res.json({ ...deps, allOk });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * GET /api/gpu/status — Current contribution status.
   */
  router.get('/status', async (_req: Request, res: Response) => {
    try {
      const status = await manager.getStatus();
      res.json(status);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * GET /api/gpu/metrics — Real-time GPU metrics (temp, VRAM, utilization).
   */
  router.get('/metrics', async (_req: Request, res: Response) => {
    try {
      const metrics = await nvidia.getMetrics();
      if (!metrics) {
        res.status(503).json({ error: 'GPU metrics unavailable' });
        return;
      }
      res.json(metrics);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * GET /api/gpu/info — GPU hardware info (cached).
   */
  router.get('/info', async (_req: Request, res: Response) => {
    try {
      const info = await nvidia.getGpuInfo();
      if (!info) {
        res.status(503).json({ error: 'No NVIDIA GPU detected' });
        return;
      }
      res.json(info);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * POST /api/gpu/start — Start GPU contribution.
   * Body: { mode?, vramUtilization?, model?, hiveUsername? }
   */
  router.post('/start', async (req: Request, res: Response) => {
    try {
      const { mode, vramUtilization, model, maxModelLen, hiveUsername } = req.body || {};

      if (mode) manager.updateConfig({ mode });
      if (vramUtilization) manager.updateConfig({ vramUtilization });
      if (model) manager.updateConfig({ model });
      if (maxModelLen) manager.updateConfig({ maxModelLen });
      if (hiveUsername) manager.updateConfig({ hiveUsername });

      await manager.start();
      res.json({ success: true, state: 'running' });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  /**
   * POST /api/gpu/stop — Stop GPU contribution (graceful drain).
   */
  router.post('/stop', async (_req: Request, res: Response) => {
    try {
      await manager.stop();
      res.json({ success: true, state: 'stopped' });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  /**
   * POST /api/gpu/pause — Pause contribution (free VRAM).
   */
  router.post('/pause', async (_req: Request, res: Response) => {
    try {
      await manager.pause();
      res.json({ success: true, state: 'paused' });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  /**
   * POST /api/gpu/resume — Resume contribution.
   */
  router.post('/resume', async (_req: Request, res: Response) => {
    try {
      await manager.resume();
      res.json({ success: true, state: 'running' });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  /**
   * POST /api/gpu/gaming-mode — Enter gaming mode (manual trigger).
   */
  router.post('/gaming-mode', async (_req: Request, res: Response) => {
    try {
      await manager.enterGamingMode();
      res.json({ success: true, state: 'gaming_mode' });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  /**
   * GET /api/gpu/config — Get current GPU contribution config.
   */
  router.get('/config', (_req: Request, res: Response) => {
    const status = manager.getStatus();
    status.then(s => res.json(s.config)).catch(err => res.status(500).json({ error: err.message }));
  });

  /**
   * POST /api/gpu/config — Update GPU contribution config.
   * Body: Partial<GpuContributionConfig>
   */
  router.post('/config', (req: Request, res: Response) => {
    try {
      manager.updateConfig(req.body);
      res.json({ success: true, message: 'Config updated' });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  /**
   * GET /api/gpu/earnings — Earnings summary.
   */
  router.get('/earnings', async (_req: Request, res: Response) => {
    try {
      const status = await manager.getStatus();
      res.json({
        totalTokens: status.totalTokens,
        totalRequests: status.totalRequests,
        estimatedHbdEarned: status.estimatedHbdEarned,
        uptimeMs: status.uptimeMs,
        state: status.state,
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}
