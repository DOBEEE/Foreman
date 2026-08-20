import express, { type Request, type Response, type Router } from "express";
import {
  applyStoredTeamImport,
  confirmTeamImport,
  createTeamExport,
  createTeamImport,
  getTeamExport,
  getTeamImport,
  previewTeamExport,
  rollbackTeamImport,
  teamBundleHistory,
  updateTeamImportPlan,
} from "../team-bundle/store.js";
import type { TeamImportPlan } from "../team-bundle/types.js";
import type { TeamExportOptions } from "../team-bundle/bundle.js";

function fail(res: Response, error: unknown, status = 400): void {
  res.status(status).json({ error: error instanceof Error ? error.message : String(error) });
}

export function registerTeamBundleRoutes(router: Router): void {
  router.post("/team-bundles/export/preview", (req: Request, res: Response) => {
    try {
      res.json(previewTeamExport((req.body ?? {}) as TeamExportOptions));
    } catch (error) {
      fail(res, error);
    }
  });

  router.post("/team-bundles/export", (req: Request, res: Response) => {
    try {
      const record = createTeamExport((req.body ?? {}) as TeamExportOptions);
      res.json({ ...record, downloadUrl: `/api/console/team-bundles/exports/${record.id}/download` });
    } catch (error) {
      fail(res, error);
    }
  });

  router.get("/team-bundles/exports/:id/download", (req: Request, res: Response) => {
    try {
      const { record, path } = getTeamExport(req.params.id);
      res.download(path, record.filename);
    } catch (error) {
      fail(res, error, 404);
    }
  });

  router.post(
    "/team-bundles/imports",
    express.raw({ type: ["application/octet-stream", "application/gzip", "application/x-gzip"], limit: "6mb" }),
    (req: Request, res: Response) => {
      try {
        if (!Buffer.isBuffer(req.body)) return fail(res, new Error("请求体必须是 .ait-team 二进制文件"));
        const filename = typeof req.query.filename === "string" ? req.query.filename : "team.ait-team";
        res.json(createTeamImport(req.body, filename));
      } catch (error) {
        fail(res, error);
      }
    },
  );

  router.get("/team-bundles/imports/:id", (req: Request, res: Response) => {
    try { res.json(getTeamImport(req.params.id)); } catch (error) { fail(res, error, 404); }
  });

  router.put("/team-bundles/imports/:id/plan", (req: Request, res: Response) => {
    try { res.json(updateTeamImportPlan(req.params.id, req.body as TeamImportPlan)); } catch (error) { fail(res, error); }
  });

  router.post("/team-bundles/imports/:id/confirm", (req: Request, res: Response) => {
    try {
      // 整体覆盖要显式带这个标记才放行（store 侧强制），后台向导的危险确认勾选映射到它
      const acknowledgeReplace = req.body?.acknowledgeReplace === true;
      res.json(confirmTeamImport(req.params.id, { acknowledgeReplace }));
    } catch (error) {
      fail(res, error);
    }
  });

  router.post("/team-bundles/imports/:id/apply", (req: Request, res: Response) => {
    try {
      const token = typeof req.body?.token === "string" ? req.body.token : "";
      res.json(applyStoredTeamImport(req.params.id, token));
    } catch (error) {
      fail(res, error);
    }
  });

  router.get("/team-bundles/history", (_req: Request, res: Response) => {
    try { res.json(teamBundleHistory()); } catch (error) { fail(res, error, 500); }
  });

  router.post("/team-bundles/rollback/:snapshotId", (req: Request, res: Response) => {
    try { res.json(rollbackTeamImport(req.params.snapshotId)); } catch (error) { fail(res, error); }
  });
}
