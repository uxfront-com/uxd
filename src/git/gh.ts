// GitHub CLI client — graceful absence (§7.3, §15.2). Never invoked in tests.

import { capture, passthrough } from "../lib/proc.ts";

export interface PrMeta {
  headRefName: string;
  isCrossRepository: boolean;
  headRepositoryOwner: string;
  state: string;
  title: string;
  author: string;
  url: string;
  /** Rolled-up CI conclusion; only populated on a fresh view, never persisted (§7.3). */
  ci?: "pass" | "fail" | "pending" | null;
}

export interface GhClient {
  available(): Promise<boolean>;
  prView(repo: string, n: number): Promise<PrMeta | null>; // null on any failure
  /** Delegate to `gh pr diff`, inheriting stdio so gh pages normally (§9.7). */
  prDiff(repo: string, n: number, args: string[]): Promise<number>; // passthrough exit code
}

const PR_FIELDS = "headRefName,isCrossRepository,headRepositoryOwner,state,title,author,url,statusCheckRollup";

interface StatusCheck {
  status?: string; // e.g. COMPLETED, IN_PROGRESS
  conclusion?: string; // e.g. SUCCESS, FAILURE, NEUTRAL
  state?: string; // legacy commit-status shape: SUCCESS, FAILURE, PENDING
}

/**
 * Reduce gh's `statusCheckRollup` array to a single CI verdict (§9.8). Any
 * failure → fail; any still-running → pending; all conclusive & clean → pass;
 * empty/absent → null (no marker).
 */
function rollupCi(rollup: StatusCheck[] | undefined): "pass" | "fail" | "pending" | null {
  if (!rollup || rollup.length === 0) return null;
  let pending = false;
  for (const c of rollup) {
    const verdict = (c.conclusion || c.state || "").toUpperCase();
    if (verdict === "FAILURE" || verdict === "ERROR" || verdict === "CANCELLED" || verdict === "TIMED_OUT") {
      return "fail";
    }
    const running = (c.status || "").toUpperCase();
    if (verdict === "" || verdict === "PENDING" || running === "IN_PROGRESS" || running === "QUEUED") {
      pending = true;
    }
  }
  return pending ? "pending" : "pass";
}

export class RealGhClient implements GhClient {
  private cachedAvailable: boolean | undefined;

  async available(): Promise<boolean> {
    if (this.cachedAvailable !== undefined) return this.cachedAvailable;
    try {
      const res = await capture(["gh", "auth", "status"], { allowFailure: true });
      this.cachedAvailable = res.code === 0;
    } catch {
      this.cachedAvailable = false;
    }
    return this.cachedAvailable;
  }

  async prView(repo: string, n: number): Promise<PrMeta | null> {
    try {
      const res = await capture(
        ["gh", "pr", "view", String(n), "--repo", repo, "--json", PR_FIELDS],
        { allowFailure: true },
      );
      if (res.code !== 0) return null;
      const raw = JSON.parse(res.stdout) as {
        headRefName?: string;
        isCrossRepository?: boolean;
        headRepositoryOwner?: { login?: string } | null;
        state?: string;
        title?: string;
        author?: { login?: string } | null;
        url?: string;
        statusCheckRollup?: StatusCheck[];
      };
      return {
        headRefName: raw.headRefName ?? "",
        isCrossRepository: raw.isCrossRepository ?? false,
        headRepositoryOwner: raw.headRepositoryOwner?.login ?? "",
        state: raw.state ?? "",
        title: raw.title ?? "",
        author: raw.author?.login ?? "",
        url: raw.url ?? "",
        ci: rollupCi(raw.statusCheckRollup),
      };
    } catch {
      return null;
    }
  }

  async prDiff(repo: string, n: number, args: string[]): Promise<number> {
    return passthrough(["gh", "pr", "diff", String(n), "--repo", repo, ...args]);
  }
}

/** A GhClient that reports unavailable — used when gh is missing and in tests. */
export const unavailableGh: GhClient = {
  available: async () => false,
  prView: async () => null,
  prDiff: async () => 0,
};
