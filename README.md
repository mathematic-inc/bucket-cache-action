# Bucket cache for GitHub Actions

`mathematic-inc/bucket-cache-action` restores files from S3 or Google Cloud Storage during a job and saves them at job
cleanup. It is derived from the S3 design in `runs-on/cache`, with an independent
storage implementation and no RunsOn runner discovery, credential overrides,
presigned download URLs, or GitHub cache-service fallback.

The base action handles archives, bucket transfers, and the restore/save lifecycle.
Wrappers such as `cache-mise`, `cache-cargo`, `cache-pnpm`, and
`cache-playwright-browsers` can choose paths and keys without installing tools or
reimplementing storage. Those wrappers are separate work.

## Usage

The examples use the release version `v1.2.0`. Pin its full commit SHA
for strict supply-chain policies. The `v1` tag tracks compatible 1.x releases.

```yaml
permissions:
  contents: read
  id-token: write

steps:
  - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
    with:
      persist-credentials: false
  - uses: mathematic-inc/bucket-cache-action@v1.2.0
    with:
      bucket: my-ci-cache
      region: us-east-1
      role-to-assume: arn:aws:iam::123456789012:role/ci-cache
      path: ~/.local/share/mise
      key: tools/development/${{ runner.os }}-${{ runner.arch }}/${{ hashFiles('mise.lock') }}
      save-if: ${{ !cancelled() && steps.install.outcome == 'success' }}
  - id: install
    uses: jdx/mise-action@c2a87611a18de5b3828c5652fe268e992400cb5c # v4.3.0
    with:
      cache: false
```

The cache step does not install anything. No separate save step is needed.

### Post-job policy

The action declares `post-if: always()` so its cleanup entry point can evaluate
`save-if`. By default, `save-if` is `${{ job.status == 'success' }}`. A caller can
supply an expression that refers to later steps, as in the example above.
GitHub re-evaluates action inputs when it invokes the post phase. The main phase
ignores `save-if`; the post phase reads its final value.

Only the save decision is re-evaluated. Provider, bucket, paths, key, archive format, and
other storage configuration are captured during restore and reused at cleanup.
An exact hit, lookup-only operation, failed restore, or empty set of files never
causes an automatic upload. A failed restore does not arm the post save, even
when `save-if` later becomes true.

### S3 authentication

With `role-to-assume`, the action obtains GitHub OIDC credentials independently
in each phase. The AWS SDK refreshes expiring credentials during transfers. This
supports long jobs and jobs that switch to a deployment role after restoring
the cache. The role must trust the job's actual GitHub OIDC subject and audience.

With `credentials-env-prefix`, the action reads static credentials in each
phase from `<prefix>_ACCESS_KEY_ID`, `<prefix>_SECRET_ACCESS_KEY` and, when it is
set, `<prefix>_SESSION_TOKEN`, as a self-hosted runner's environment may hold
them under other names than AWS's. No `AWS_*` credential is read or set, so later
steps keep their own, and the values are masked. A missing key ID or secret is a
storage error, never a reason to sign with other credentials.

```yaml
- uses: mathematic-inc/bucket-cache-action@v1.2.0
  with:
    bucket: my-office-cache
    region: us-east-1
    endpoint: https://s3.office.example.com:9000
    force-path-style: true
    credentials-env-prefix: OFFICE_S3
    connect-timeout-seconds: 5
    path: ~/.cache/pnpm
    key: pnpm/${{ runner.os }}-${{ runner.arch }}/${{ hashFiles('pnpm-lock.yaml') }}
```

Without `role-to-assume` or `credentials-env-prefix`, the AWS SDK uses its normal
credential provider chain. In that mode, credentials must still be available to
the post step. A later
`configure-aws-credentials` call or cleanup can change the job environment;
prefer the action's OIDC mode for jobs that switch roles. The action never clears
or exports AWS environment variables, and never stores credentials or OIDC
tokens in its restore-to-post state.

### Tiers

A cache can be kept in several buckets, hot first: a fast one on a self-hosted
fleet's own network, which runners outside the fleet can't reach and which may
be down, then a slower one in the cloud that is always there. `tiers` takes them
as an ordered YAML list in place of the single-bucket inputs:

```yaml
permissions:
  contents: read
  id-token: write

steps:
  - uses: mathematic-inc/bucket-cache-action@v1.2.0
    with:
      tiers: |
        - name: lan
          bucket-env: RR_S3_BUCKET
          region-env: RR_S3_REGION
          endpoint-env: RR_S3_ENDPOINT
          force-path-style: true
          credentials-env-prefix: RR_S3
          connect-timeout-seconds: 2
        - name: aws
          bucket: my-ci-cache
          region: us-east-1
          role-to-assume: arn:aws:iam::123456789012:role/ci-cache
      path: ~/.cache/pnpm
      key: pnpm/${{ runner.os }}-${{ runner.arch }}/${{ hashFiles('pnpm-lock.yaml') }}
      restore-keys: pnpm/${{ runner.os }}-${{ runner.arch }}/
```

Each tier takes the single-bucket inputs' names: a `name`; `provider`, `s3` by
default; `bucket`, `endpoint`, and for S3 `region` and `force-path-style`; a
sign-in, `role-to-assume` (with an optional `audience`) or
`credentials-env-prefix` for S3, and `workload-identity-provider` (with an
optional `service-account`), `credentials-file` or `anonymous: true` for GCS;
`connect-timeout-seconds` for S3; and `save: false` for a tier that is only
restored from. A tier always names its sign-in, so whether it is present is
known; `credentials-env-prefix: AWS` reads the job's own `AWS_*` credentials.
`bucket`, `region`, `endpoint`, `role-to-assume`, `workload-identity-provider`,
`service-account` and `credentials-file` can instead name the runner's
environment variable that holds them, as `bucket-env`, since a fleet sets them on
its runners rather than in the workflow's `env` context. The list is checked
strictly: an unknown key, a wrong type, a value given both ways, a missing one or
a malformed one written in the list fails the step with the tier and key it
concerns, never a value, since that is the workflow's mistake. A malformed value
in the runner's environment is the runner's: it skips its tier with a warning
naming the variable, never its value, or fails the step with `fail-on-error`.
A workflow gives `tiers` or the single-bucket inputs, not both; those inputs are
one tier named `default`, and behave as they always have.

A tier is present when the runner sets every variable it names, its credential
prefix's `_ACCESS_KEY_ID` and `_SECRET_ACCESS_KEY` among them; an absent tier is
skipped, saying which variables aren't set. A present tier that can't sign in, or
whose first request gets no answer, is skipped with a warning: that request is
made once, so a tier that is down costs its `connect-timeout-seconds`. A tier
that answers with an error is skipped with a warning too, or fails the step with
`fail-on-error`. Skipping a tier that is absent or can't be reached never fails
a step; when no tier is left, the step fails as one bucket's would, with a
warning unless `fail-on-error`.

Restoring looks for the exact key in each tier, hot to cold, then for the first
restore key in each tier, then the second, and so on; the first match restores. A
more specific key beats a less specific one in any tier: an exact hit in a cold
tier beats a restore-key match in a hot one, and a match for the first restore
key in a cold tier beats one for the second in a hot one. The `tier` output names
the tier it came from.

Saving writes through. At cleanup the action saves the key to every present tier
that saves and doesn't hold it yet, all at once: a hit from a colder tier is
promoted to the hotter ones, and the colder ones stay complete for runners that
can't reach the hot one. After an exact hit it asks the other tiers first, and
packs the paths only if one lacks the key. One tier's failure doesn't stop the
others, and each tier's outcome is logged. As with one bucket, the tiers' values
are read at restore and reused at cleanup, and their credentials are read again
in each phase.

### Google Cloud Storage

Select `provider: gcs`. Native Workload Identity Federation obtains and refreshes
credentials in both the restore and post phases:

```yaml
- uses: mathematic-inc/bucket-cache-action@v1.2.0
  with:
    provider: gcs
    bucket: my-ci-cache
    workload-identity-provider: projects/123456789012/locations/global/workloadIdentityPools/github/providers/github
    service-account: cache@example-project.iam.gserviceaccount.com
    path: ~/.cache/pnpm
    key: pnpm/development/${{ runner.os }}/${{ hashFiles('pnpm-lock.yaml') }}
    save-if: ${{ !cancelled() && steps.install.outcome == 'success' }}
```

The job needs `id-token: write`. The provider must trust the repository and the
job's GitHub subject. Service-account impersonation is optional: a workload
identity principal with direct bucket access can omit `service-account`.

Without `workload-identity-provider`, the Google auth library uses Application
Default Credentials. `credentials-file` defaults to the
`GOOGLE_APPLICATION_CREDENTIALS` file path present at restore time. The path,
not the credential contents, is kept for cleanup. The credential source must
remain available until the cache's post phase finishes. Native federation avoids
dependence on another action's credential-file cleanup order.

For a local GCS emulator, set an explicit loopback `endpoint` and
`anonymous: true`. Anonymous mode is rejected for non-loopback endpoints and
cannot be combined with credentials. Production GCS always uses authentication.

## Inputs

| Input                        | Default                          | Meaning                                                                                                                                     |
| ---------------------------- | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `tiers`                      | Empty                            | Ordered YAML list of buckets, hot first, in place of `provider` through `anonymous`. See [Tiers](#tiers).                                   |
| `provider`                   | `s3`                             | `s3` or `gcs`.                                                                                                                              |
| `bucket`                     | Required without `tiers`         | Existing bucket in the selected provider.                                                                                                   |
| `region`                     | AWS region environment           | S3 and STS region; not required for GCS.                                                                                                    |
| `path`                       | Required                         | Newline-separated files, directories, or glob patterns. Supports `~` and exclusions.                                                        |
| `key`                        | Required                         | Immutable cache key; at most 512 characters.                                                                                                |
| `restore-keys`               | Empty                            | Ordered fallback prefixes. Exact lookup runs first, then the newest object under the first matching prefix wins.                            |
| `prefix`                     | `cache`                          | Root object prefix.                                                                                                                         |
| `role-to-assume`             | Empty                            | IAM role to assume with GitHub OIDC in each phase.                                                                                          |
| `audience`                   | `sts.amazonaws.com`              | OIDC audience.                                                                                                                              |
| `credentials-env-prefix`     | Empty                            | Read static S3 credentials in each phase from `<prefix>_ACCESS_KEY_ID`, `<prefix>_SECRET_ACCESS_KEY` and `<prefix>_SESSION_TOKEN`.          |
| `endpoint`                   | AWS S3                           | HTTP(S) API endpoint without credentials, query, or fragment.                                                                               |
| `force-path-style`           | `false`                          | Use path-style addressing for S3-compatible services.                                                                                       |
| `workload-identity-provider` | Empty                            | GCS Workload Identity Federation provider resource name.                                                                                    |
| `service-account`            | Empty                            | Optional GCS service account to impersonate with native federation.                                                                         |
| `credentials-file`           | `GOOGLE_APPLICATION_CREDENTIALS` | GCS ADC configuration file; its path is captured for the post phase.                                                                        |
| `anonymous`                  | `false`                          | GCS emulator-only anonymous access on loopback.                                                                                             |
| `save-if`                    | `${{ job.status == 'success' }}` | Boolean or expression controlling the post-job save.                                                                                        |
| `lookup-only`                | `false`                          | Report a match without downloading or saving.                                                                                               |
| `fail-on-cache-miss`         | `false`                          | Fail if no key matches.                                                                                                                     |
| `fail-on-error`              | `false`                          | Fail on cache I/O errors instead of warning. Configuration errors always fail.                                                              |
| `timeout-seconds`            | `600`                            | Deadline for bucket restore or upload operations. Local archive creation/extraction is outside this transfer deadline.                      |
| `connect-timeout-seconds`    | `10`                             | Deadline for opening each S3 connection, from 1 to 300.                                                                                     |
| `concurrency`                | `4`                              | Parallel S3 upload parts and download ranges for both providers, from 1 to 32.                                                              |
| `part-size-mib`              | `32`                             | S3 upload part, GCS upload chunk, and download range size, from 5 to 512 MiB. Uploads increase it if necessary to stay within 10,000 parts. |
| `max-size-mib`               | `102400`                         | Maximum compressed archive size.                                                                                                            |

Outputs are `cache-hit` (`true` only for an exact match), `cache-primary-key`,
`cache-matched-key` (empty on a miss), `tier`, the name of the tier the match
came from (`default` for the single-bucket inputs; empty on a miss), and
`first-tier`, the name of the hottest tier that was present and answered, hit or
miss (empty when none did), for a tool that takes one bucket, such as a compiler
cache, to use the same one. A fallback restore has `cache-hit: false`.
`lookup-only` reports whether a key exists without validating the archived bytes.

`mathematic-inc/bucket-cache-action/restore@v1.2.0` restores without registering a post
step. `mathematic-inc/bucket-cache-action/save@v1.2.0` saves immediately. These entry
points use the same storage and archive implementation; the save entry point
has no lookup or `save-if` inputs.

## Storage and trust

Objects use this layout:

```text
<prefix>/<owner>/<repository>/<archive-version>/<key>
```

The version is a SHA-256 digest of the format version, path patterns,
compression, OS, and architecture. A format-specific salt prevents accidental
reuse of runs-on/cache archives. Existing caches start cold after migration.
Archives use the current `tar` package and Node 24's native zstd implementation;
no system tar or compression binary is required. Paths outside the workspace and file modes
are preserved. Windows and Unix archives are deliberately separated.

Neither backend enforces GitHub's branch cache restrictions. Repository names and
keys prevent accidental collisions; AWS IAM and Google Cloud IAM policies must enforce which writers can
populate a cache. Separate untrusted pull-request caches from trusted build and
deployment caches, and limit each role to its intended key prefixes. Anyone who
can write a cache can supply executable tools and dependencies to its readers.
Do not cache credentials or other secrets.

The required bucket permissions are `s3:ListBucket`, `s3:GetObject`,
`s3:PutObject`, and `s3:AbortMultipartUpload` for the permitted prefixes.
GCS requires `storage.objects.get`, `storage.objects.list`, and
`storage.objects.create` on the permitted namespace. Since writes never replace
existing objects, `storage.objects.delete` is not required. A tier with `save: false`
is only read, so it needs no permission to write.

Neither backend needs object deletion, bucket creation, or bucket policy permissions.
The bucket owns encryption and retention policy. Configure expiration for old
cache objects and an incomplete-multipart-upload lifecycle rule for runner
crashes or forced termination.

S3 writes use `If-None-Match: *`, including multipart completion. A competing writer
cannot replace a completed cache. Failed and losing multipart uploads are
explicitly aborted. GCS uploads use resumable sessions with `ifGenerationMatch=0`. The action
queries the committed offset after an ambiguous response and cancels failed
sessions. Session URLs are bearer capabilities; they are masked in logs and
never stored in action state. Google Cloud expires orphaned sessions after a
week, covering crashes where the runner cannot send cancellation.

Downloads use bounded parallel byte ranges pinned to an S3 ETag or GCS object
generation, validate range lengths, and verify the full SHA-256 digest before
extraction. The digest detects corruption; it does not authenticate a malicious
writer who can also replace object metadata. An invalid immutable cache requires
a new key/version or removal by its owner.

Fallback listing follows pagination and selects the newest candidate across all
pages, with a deterministic key tie-break. It refuses a lookup beyond 1,000
pages rather than returning a potentially incorrect partial result. Narrow the
fallback prefixes for very large buckets. Storage errors are reported, rather
than silently reclassified as misses.

## Development

Node.js 24 or newer is required. Oxfmt formats the source, Oxlint checks it with
type information, and TypeScript performs a separate typecheck. Action consumers run the committed bundles in
`dist` and do not need `npm install`.

```sh
npm ci --ignore-scripts
npm run check
npm test
npm run build
npm run test:integration
```

Unit tests cover input validation, isolation, selection/pagination, stream
validation, and post-job policy. Archive tests run on Linux, macOS, and Windows.
Integration tests start two disposable, digest-pinned MinIO containers, as a hot and a cold tier, and a
checksum-pinned GCS emulator on loopback with fake credentials and temporary bind mounts. They exercise multipart
races/cleanup, resumable GCS uploads, range downloads, and the actual bundled action across separate
restore and post processes, tiers among them: misses, promotion, a more specific key in the cold tier
over a less specific one in the hot one, a hot tier that is down or whose variables are unset or
malformed, and `save: false`. No test uses a production bucket or cloud account. The GCS emulator does not
enforce upload generation preconditions, so request/412 conflict tests verify
that contract separately against controlled HTTP responses. GitHub CI also tests
the runner's actual default, disabled, and later-step-dependent post policies.

`npm run build` regenerates the bundles and their dependency license notices.
CI checks that the committed artifacts match the source.

## License and origin

MIT. See [LICENSE](LICENSE), [NOTICE](NOTICE), and
[the bundled dependency licenses](dist/licenses.txt). The archive/S3 separation
and repository/version/key layout are based on
[runs-on/cache](https://github.com/runs-on/cache); the transfer and lifecycle
implementation in this repository is maintained independently.
