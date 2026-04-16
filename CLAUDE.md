# CLAUDE.md

## Doc Artifacts

Design docs, specs, plans, brainstorming output, and superpowers artifacts for this repo live in the SpanPanel_Docs workspace, NOT in this repo:

- `/Users/bflood/projects/HA/SpanPanel_Docs/span/docs/superpowers/plans/` — superpowers plan artifacts
- `/Users/bflood/projects/HA/SpanPanel_Docs/span/docs/superpowers/specs/` — superpowers spec artifacts
- `/Users/bflood/projects/HA/SpanPanel_Docs/span/docs/dev/` — developer plans, specs, design documents

When invoking the brainstorming or writing-plans skill, override its default location (which is `docs/superpowers/...` in the current repo) with the correct
path in SpanPanel_Docs. Never write `.md` design artifacts into this repo.

If a doc was already written to the wrong location, copy it to the correct location before removing from this repo. Do not auto-commit in SpanPanel_Docs since
that repo may have unrelated pending changes — leave new files as untracked for the user to commit.

This matches the AGENTS.md convention in the sibling `span` integration repo (`/Users/bflood/projects/HA/span/AGENTS.md`) — the two repos are maintained
together and share the same doc-artifact rule.

## Attribution

Never include references to AI models, AI assistants, or AI-generated content in any code, comments, commit messages, PR descriptions, documentation, or other
output. This includes "Co-Authored-By" tags, "Generated with" footers, and any similar attribution.

## Related

- Sibling integration repo: `/Users/bflood/projects/HA/span` (has its own AGENTS.md with the integration-specific conventions)
- After any change under `src/`, the integration's bundled JS must be rebuilt and copied via the `sync-frontend` skill or
  `/Users/bflood/projects/HA/span/scripts/build-frontend.sh`.
