---
"@uxfront/uxd": patch
---

Skip `node_modules/` and `.git/` while expanding `setup.cache_key` globs, not
after. A `**` pattern such as `**/package.json` used to walk every installed
dependency before the matches were filtered, so once a workspace had been set
up, each later `run` could spend a minute or more hashing in a large monorepo
before it started anything. The set of hashed files is unchanged, so existing
workspaces do not re-run setup.
