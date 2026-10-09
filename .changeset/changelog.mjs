// Stock changelog-git output, minus the kind prefix (`feat:`, `fix(scope):`, …) every changeset summary starts
// with, so it stays out of CHANGELOG.md and the GitHub Release body. Plain .mjs because changesets imports it
// with its own resolver during `changeset version`.

import changelogGit from '@changesets/cli/changelog'

const KIND_PREFIX =
  /^(?:build|chore|ci|docs|feat|feature|fix|improve|improvement|other|perf|refactor|revert|style|test)(?:\([^)]*\))?!?:[ \t]+/

const changelogFunctions = {
  ...changelogGit,
  getReleaseLine: (changeset, type, options) =>
    changelogGit.getReleaseLine({ ...changeset, summary: changeset.summary.replace(KIND_PREFIX, '') }, type, options),
}

export default changelogFunctions
