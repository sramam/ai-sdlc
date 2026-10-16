@ai-sdlc/promote: `promote <env>` fast-forwards an environment from a green `local-ci` SHA, `rollback <env>` runs the configured rollback, and `release` tags a commit on the integration branch. See README.md.

- **Only `local-ci` = success is green.** Never accept `local-ci/allow-unknown` as a pass. Promotion has no override at all. In release, `--allow-unknown` covers unknown but never red.
- **Fast-forward only.** Never merge, rebase, force, or open a PR into the staging or production branch.
- **Order is fixed.** The checks and the dry-run push come before migrate, and migrate comes before deploy, push and smoke. Nothing that changes an environment runs before every check has answered.
- **Deploy from the temporary checkout at the exact SHA**, never from the working tree.
- **Release never pushes and never edits `package.json`.** It prints the push command.
- **Every external call goes through the injected `Exec`, `httpGet` or `tempDir`.** Tests use scripted fakes and temporary git repositories, never a real gh or vendor CLI.
