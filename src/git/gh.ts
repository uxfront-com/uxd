// GitHub CLI client — graceful absence (§7.3, §15.2). Never invoked in tests.

import { capture } from "../lib/proc.ts";

export interface PrMeta {
  headRefName: string;
  isCrossRepository: boolean;
  headRepositoryOwner: string;
  state: string;
  title: string;
  author: string;
  url: string;
}

export interface GhClient {
  available(): Promise<boolean>;
  prView(repo: string, n: number): Promise<PrMeta | null>; // null on any failure
  prDiff(repo: string, n: number): Promise<number>; // passthrough exit code
}

const PR_FIELDS = "headRefName,isCrossRepository,headRepositoryOwner,state,title,author,url";

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
      };
      return {
        headRefName: raw.headRefName ?? "",
        isCrossRepository: raw.isCrossRepository ?? false,
        headRepositoryOwner: raw.headRepositoryOwner?.login ?? "",
        state: raw.state ?? "",
        title: raw.title ?? "",
        author: raw.author?.login ?? "",
        url: raw.url ?? "",
      };
    } catch {
      return null;
    }
  }

  async prDiff(): Promise<number> {
    // Delegation implemented in M2 (`diff` verb).
    return 0;
  }
}

/** A GhClient that reports unavailable — used when gh is missing and in tests. */
export const unavailableGh: GhClient = {
  available: async () => false,
  prView: async () => null,
  prDiff: async () => 0,
};
