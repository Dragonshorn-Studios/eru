// Per-repo mapping-job state, kept in memory so a refresh survives page
// navigation: leave mid-map, come back, and the pane resumes the progress
// view instead of starting over. Finished notices are consumed once by the
// next full render. In-memory on purpose — a dead process ends the OpenCode
// child too, so no stale "running" state can outlive the run.
export type MappingKind = "map" | "explore";

export interface MappingJob {
  status: "running" | "done" | "failed";
  /** map = operator refresh. explore = Eru reading a checkout for an issue. */
  kind: MappingKind;
  notice?: string;
  startedAt: number;
  finishedAt?: number;
}

export interface MappingTracker {
  /** State for one repo; finished jobs linger until consumed or restarted. */
  get(repoId: number): MappingJob | undefined;
  /** Mark a run started; false when one is already in flight for this repo. */
  start(repoId: number, now: number, kind?: MappingKind): boolean;
  finish(repoId: number, status: "done" | "failed", notice: string, now: number): void;
  /** Take a finished job once; running jobs are not consumed. */
  consume(repoId: number): MappingJob | undefined;
}

export function createMappingTracker(): MappingTracker {
  const jobs = new Map<number, MappingJob>();
  return {
    get: (repoId) => jobs.get(repoId),
    start(repoId, now, kind = "map") {
      if (jobs.get(repoId)?.status === "running") return false;
      jobs.set(repoId, { status: "running", kind, startedAt: now });
      return true;
    },
    finish(repoId, status, notice, now) {
      const prev = jobs.get(repoId);
      jobs.set(repoId, {
        status,
        kind: prev?.kind ?? "map",
        notice,
        startedAt: prev?.startedAt ?? now,
        finishedAt: now,
      });
    },
    consume(repoId) {
      const job = jobs.get(repoId);
      if (!job || job.status === "running") return undefined;
      jobs.delete(repoId);
      return job;
    },
  };
}
