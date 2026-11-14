---
"@uxfront/testlane": minor
---

Read a `.testlane.toml` that a repo commits, so `testlane config add <url>` sets up a project without hand-written TOML. Its commands run only after you approve the file from the default branch, and `config show` marks where each key came from. A script that runs off a terminal without `--yes` stops with `E_CONFIG` once the repo adds or changes the file, until you run `testlane config trust <project>`.
