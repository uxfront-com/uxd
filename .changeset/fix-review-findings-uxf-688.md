---
"@uxfront/testlane": patch
---

`--branch` refuses names that git would read as a refspec, like `a:b` or `+x`, with exit code 4. Before, such a name reached `git fetch`, where it could write a ref other than the branch you asked for. On macOS and Windows, a branch name that differs from another fetched branch only in case, like `Main` beside `main`, is refused too, since both would land in the same file.
