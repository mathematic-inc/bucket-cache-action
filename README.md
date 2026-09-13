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

Use a reviewed commit SHA for the action reference. The examples below use
`<commit-sha>` to identify that pin; there is no mutable release tag yet.

```yaml
permissions:
  contents: read
  id-token: write

steps:
  - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
    with:
      persist-credentials: false
  - uses: mathematic-inc/bucket-cache-action@<commit-sha>
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

Without `role-to-assume`, the AWS SDK uses its normal credential provider chain.
In that mode, credentials must still be available to the post step. A later
`configure-aws-credentials` call or cleanup can change the job environment;
prefer the action's OIDC mode for jobs that switch roles. The action never clears
or exports AWS environment variables, and never stores credentials or OIDC
tokens in its restore-to-post state.

### Google Cloud Storage

Select `provider: gcs`. Native Workload Identity Federation obtains and refreshes
credentials in both the restore and post phases:

```yaml
- uses: mathematic-inc/bucket-cache-action@<commit-sha>
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
| `provider`                   | `s3`                             | `s3` or `gcs`.                                                                                                                              |
| `bucket`                     | Required                         | Existing bucket in the selected provider.                                                                                                   |
| `region`                     | AWS region environment           | S3 and STS region; not required for GCS.                                                                                                    |
| `path`                       | Required                         | Newline-separated files, directories, or glob patterns. Supports `~` and exclusions.                                                        |
| `key`                        | Required                         | Immutable cache key; at most 512 characters.                                                                                                |
| `restore-keys`               | Empty                            | Ordered fallback prefixes. Exact lookup runs first, then the newest object under the first matching prefix wins.                            |
| `prefix`                     | `cache`                          | Root object prefix.                                                                                                                         |
| `role-to-assume`             | Empty                            | IAM role to assume with GitHub OIDC in each phase.                                                                                          |
| `audience`                   | `sts.amazonaws.com`              | OIDC audience.                                                                                                                              |
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
| `concurrency`                | `4`                              | Parallel S3 upload parts and download ranges for both providers, from 1 to 32.                                                              |
| `part-size-mib`              | `32`                             | S3 upload part, GCS upload chunk, and download range size, from 5 to 512 MiB. Uploads increase it if necessary to stay within 10,000 parts. |
| `max-size-mib`               | `102400`                         | Maximum compressed archive size.                                                                                                            |

Outputs are `cache-hit` (`true` only for an exact match), `cache-primary-key`, and
`cache-matched-key` (empty on a miss). A fallback restore has `cache-hit: false`.
`lookup-only` reports whether a key exists without validating the archived bytes.

`mathematic-inc/bucket-cache-action/restore@<commit-sha>` restores without registering a post
step. `mathematic-inc/bucket-cache-action/save@<commit-sha>` saves immediately. These entry
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
GNU/BSD tar handling comes from the pinned GitHub toolkit; zstd is used when
available, with gzip as the fallback. Paths outside the workspace and file modes
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
existing objects, `storage.objects.delete` is not required.

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

Node.js 24 or newer is required. Action consumers run the committed bundles in
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
Integration tests start a disposable, digest-pinned MinIO container and a checksum-pinned GCS emulator on loopback
with fake credentials and a temporary bind mount. They exercise multipart
races/cleanup, resumable GCS uploads, range downloads, and the actual bundled action across separate
restore and post processes. No test uses a production bucket or cloud account. The GCS emulator does not
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
