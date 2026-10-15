# Repository and store release protection

These files are GitHub REST API request bodies for `motrixapp/motrix-extension`.
The four `*.ruleset.json` files can also be imported individually through
Settings → Rules → Rulesets → New ruleset → Import a ruleset. Committing these
files does not apply the settings; GitHub does not load them automatically.

## Policy

| File | Effect |
| --- | --- |
| `main.ruleset.json` | PRs, the GitHub Actions `Extension checks` aggregate (static checks plus both Firefox takeover jobs), up-to-date branches, and resolved conversations. Only owner account `agalwood` (user ID 1032175) can bypass these requirements for a direct push. |
| `main-integrity.ruleset.json` | Linear history; no force pushes or deletion, with no bypass actors, including the owner. |
| `release-tag-creation.ruleset.json` | Only the repository Admin role (ID 5) can create `v*` tags. |
| `release-tag-integrity.ruleset.json` | Nobody can update or delete existing `v*` tags while the rule is active, including tag creators. |
| `store-environment.json` | Required reviewer `agalwood` (user ID 1032175), self-review permitted, admin bypass disabled, custom branch policies required. Apply separately to all three store environments. |
| `main-deployment-policy.json` | Only the branch `main` may use a store environment; a tag named `main` is not allowed. |
| `actions-workflow-permissions.json` | Default `GITHUB_TOKEN` is read-only and cannot approve PRs. Individual jobs still declare the minimum permissions they require. |

This is the requested **solo-maintainer, owner-direct-push** policy. The owner
account `agalwood` can make normal fast-forward pushes to main without a PR or
pre-push CI result. The push still triggers CI; a later failed check does not
undo that push. Other writers must use PRs and pass CI. The bypass is attached
to this one user, not every repository administrator. If ownership changes,
update the configured user ID after verifying the new owner's identity.

PRs require zero independent approvals because GitHub does not let authors approve their own PRs. CODEOWNERS
records security-file ownership but owner approval is not mandatory in this
profile. Publishing requires a separate environment approval by the maintainer,
even for credential-bearing dry runs. This prevents accidental publishing and
use of store credentials from other branches; it is not two-person control and
does not protect against a compromised administrator who can change settings.

The tag rules are intentionally separate. An administrator bypasses only the
creation restriction, not the integrity restriction. GitHub Actions (App ID
15368) is the required check provider; this limits status spoofing but does not
replace reviewing changes to CI itself. No PAT or App token is added to CI.

## Apply in the correct order

1. Validate and publish the workflow changes through a PR or an authorized
   owner push. Confirm the `Extension checks` job succeeds after the update.
2. Create and verify the environments and their exact `main` branch policies.
3. Configure each store's secrets **only in its environment**, then remove any
   repository or organization secret of the same name that is exposed to this
   repository. A repository secret remains accessible to other workflows even
   when the submit job references an environment.
4. Apply all four rulesets and the default token-permission policy. Only the
   configured owner can bypass the PR/CI gate; everyone still follows the
   main-integrity rule.
5. Release a new version from a protected tag, then verify provenance and approve
   a dry run. Do not remove protection to make an old unattested release pass.

Use an existing administrator `gh` login to manage settings. Never store an
administrator token as an Actions secret for this purpose. Review the payloads
before applying. For a different repository, update reviewer identity and CI
check/provider as appropriate.

### Store environments

Run from the repository root. On a repository with existing environments,
inspect them first: PUT replaces the supplied reviewer and branch-policy
settings. Preserve unrelated settings rather than blindly weakening them.

```bash
for store in chrome edge firefox; do
  gh api --method PUT "repos/motrixapp/motrix-extension/environments/store-$store" \
    --input .github/security/store-environment.json
  gh api --method POST "repos/motrixapp/motrix-extension/environments/store-$store/deployment-branch-policies" \
    --input .github/security/main-deployment-policy.json
done

gh api --method PUT repos/motrixapp/motrix-extension/actions/permissions/workflow \
  --input .github/security/actions-workflow-permissions.json
```

For a repeated application, list each environment's `deployment-branch-policies`
first, retain the existing exact `main`/`branch` policy, and do not create
duplicates. Remove any wider branch/tag policy after checking its purpose.
Verify `can_admins_bypass: false` in the response; if the API does not accept
that setting, disable administrator bypass in Settings → Environments.

### Rulesets

List existing rulesets before importing so an update does not create duplicates:

```bash
gh api 'repos/motrixapp/motrix-extension/rulesets?includes_parents=false' \
  --jq '.[] | {id, name, enforcement}'

# Create each rule only when no rule with the same name exists.
gh api --method POST repos/motrixapp/motrix-extension/rulesets \
  --input .github/security/main-integrity.ruleset.json
gh api --method POST repos/motrixapp/motrix-extension/rulesets \
  --input .github/security/main.ruleset.json
gh api --method POST repos/motrixapp/motrix-extension/rulesets \
  --input .github/security/release-tag-creation.ruleset.json
gh api --method POST repos/motrixapp/motrix-extension/rulesets \
  --input .github/security/release-tag-integrity.ruleset.json

# For an existing rule, substitute its ID and the corresponding JSON file.
gh api --method PUT repos/motrixapp/motrix-extension/rulesets/RULESET_ID \
  --input .github/security/main.ruleset.json
```

Do not attach the store deployment environments as required deployments on
`main`: that would make merging depend on publishing the same change first.
Do not add any bypass to `main-integrity.ruleset.json` or the tag-integrity
ruleset. Keep the owner bypass confined to the PR/CI rule.

## Verify actual server state

```bash
gh api repos/motrixapp/motrix-extension/rules/branches/main
gh api 'repos/motrixapp/motrix-extension/rulesets?includes_parents=true'
gh api repos/motrixapp/motrix-extension/environments
for store in chrome edge firefox; do
  gh api "repos/motrixapp/motrix-extension/environments/store-$store"
  gh api "repos/motrixapp/motrix-extension/environments/store-$store/deployment-branch-policies"
  gh secret list --repo motrixapp/motrix-extension --env "store-$store"
done
gh secret list --repo motrixapp/motrix-extension
gh api repos/motrixapp/motrix-extension/actions/organization-secrets --jq '.secrets[].name'
gh api repos/motrixapp/motrix-extension/actions/permissions/workflow
```

Confirm the required reviewer, no admin bypass, exactly one `main` branch policy
per environment, and no store credential outside its environment. A ruleset JSON
file or an `environment:` declaration alone is not proof that these protections
are enabled on GitHub.

## Release provenance

`release.yml` builds only from its exact `refs/tags/vX.Y.Z` workflow revision and
requires the commit to be an ancestor of main (via PR or an authorized owner
push). Builds run without OIDC or
attestation-write permissions. A separate publishing job downloads that run's
artifacts and signs them with the SHA-pinned official `actions/attest` action,
then creates a draft release, uploads assets, and publishes it. This ordering
also works if immutable releases are enabled separately.

Submission verifies the signature, repository, exact release workflow path,
tag ref, source commit, signer commit, and GitHub-hosted runner identity for all
three ZIPs and `SHA256SUMS.txt`. It rechecks after environment approval against
the commit recorded in the preparation job. A missing, mismatched, or invalid
attestation fails closed; there is no checksum-only or legacy bypass.

Older releases such as v0.1.11 have no attestations from this workflow and cannot
be submitted through the hardened workflow. Publish a new version from the
updated main branch. Do not delete/recreate a protected old tag or back-sign
unverified downloaded binaries. Attestations establish origin and integrity;
they do not establish that the extension is free of vulnerabilities.

## Team migration

When moving to mandatory peer review, first remove the owner bypass from the
PR/CI ruleset. When a second trusted maintainer is available, update the
environment reviewer
list and enable `prevent_self_review`. Set main's required approval count to at
least one, enable CODEOWNER review and last-push approval, and include an
independent owner for the security paths. Apply and verify the changes on
GitHub. Do not enable these requirements for a sole reviewer who is also the
only PR author.

References: [GitHub rulesets API](https://docs.github.com/en/rest/repos/rules),
[environment API](https://docs.github.com/en/rest/deployments/environments),
[deployment branch policies](https://docs.github.com/en/rest/deployments/branch-policies),
[attestation verification](https://cli.github.com/manual/gh_attestation_verify),
[official attestation action](https://github.com/actions/attest).
