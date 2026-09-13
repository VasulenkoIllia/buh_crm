#!/usr/bin/env bash
#
# Prove, with both real keys, that the files bucket does what its policy says — before the first
# client file goes into it.
#
#   ./scripts/storage/check-files-bucket.sh <bucket> <location> [<backups-bucket> <backups-location>]
#
# It asks for the CRM's key (project buhcrm-app), then the backup's (project buhcrm-backup):
#   the CRM's key     works: list, upload, read back, a plain delete (which only hides)
#                     refused: deleting a version for good, rewriting the policy / versioning /
#                     lifecycle / public access block, deleting the bucket, an ACL change, a public
#                     upload, and — when given — anything on the backups bucket
#   the backup's key  works: list, read what the CRM stored, versioning reads Enabled
#                     refused: upload, delete, reading or listing by version, rewriting the policy
#   nobody            an anonymous read is refused
#
# Every probe is harmless even if it were wrongly accepted: the policy probe sends a body that is
# not JSON, versioning, lifecycle and the public access block are re-sent unchanged, the bucket is
# not empty, the ACL asked for is `private`. The probes leave a hidden object under check/ that
# neither key can remove — that is the point — and the lifecycle deletes it after 30 days.
#
# Nothing here names a real bucket or key: this repository is public.

set -euo pipefail
SELF="$(cd "$(dirname "$0")" && pwd)/$(basename "$0")"
cd "$(dirname "$SELF")"

usage() { sed -n '2,22p' "$SELF" | sed 's/^# \{0,1\}//'; exit 2; }
[ $# -eq 2 ] || [ $# -eq 4 ] || usage
BUCKET=$1
LOCATION=$2
OTHER_BUCKET=${3:-}
OTHER_LOCATION=${4:-}

for loc in "$LOCATION" ${OTHER_LOCATION:+"$OTHER_LOCATION"}; do
  case "$loc" in
    fsn1 | nbg1 | hel1) ;;
    *) echo "location must be fsn1, nbg1 or hel1, not '$loc'" >&2; exit 2 ;;
  esac
done
for tool in aws jq curl; do
  command -v "$tool" >/dev/null || { echo "$tool is missing" >&2; exit 1; }
done

# ── the two keys ─────────────────────────────────────────────────────────────
APP_ID=
APP_SECRET=
BACKUP_ID=
BACKUP_SECRET=
# `|| true`: at end of input `read` fails, and `set -e` would end the script without a word
printf "The CRM's key — project buhcrm-app\n  access key: " >&2
read -r APP_ID || true
printf '  secret (not shown): ' >&2
read -rs APP_SECRET || true
printf "\nThe backup's key — project buhcrm-backup\n  access key: " >&2
read -r BACKUP_ID || true
printf '  secret (not shown): ' >&2
read -rs BACKUP_SECRET || true
printf '\n' >&2
[ -n "$APP_ID" ] && [ -n "$APP_SECRET" ] && [ -n "$BACKUP_ID" ] && [ -n "$BACKUP_SECRET" ] ||
  { echo "both keys are needed" >&2; exit 2; }
[ "$APP_ID" != "$BACKUP_ID" ] || { echo "the two keys must be different keys" >&2; exit 2; }

unset AWS_PROFILE AWS_SESSION_TOKEN
export AWS_CONFIG_FILE=/dev/null AWS_SHARED_CREDENTIALS_FILE=/dev/null
export AWS_DEFAULT_REGION="$LOCATION" AWS_ENDPOINT_URL="https://$LOCATION.your-objectstorage.com"
export AWS_REQUEST_CHECKSUM_CALCULATION=when_required AWS_RESPONSE_CHECKSUM_VALIDATION=when_required
as_app() { export AWS_ACCESS_KEY_ID="$APP_ID" AWS_SECRET_ACCESS_KEY="$APP_SECRET"; }
as_backup() { export AWS_ACCESS_KEY_ID="$BACKUP_ID" AWS_SECRET_ACCESS_KEY="$BACKUP_SECRET"; }

SCRATCH=$(mktemp -d)
trap 'rm -rf "$SCRATCH"' EXIT
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
KEY="check/probe-$STAMP.txt"
printf 'buh_crm files bucket check %s\n' "$STAMP" >"$SCRATCH/probe.txt"

PASSED=0
FAILED=0
say() { printf '\n\033[1m▸ %s\033[0m\n' "$1"; }
pass() { printf '   \033[32m✓\033[0m %s\n' "$1"; PASSED=$((PASSED + 1)); }
fail() { printf '   \033[31m✗\033[0m %s\n' "$1"; FAILED=$((FAILED + 1)); }
# The storage's own error code, read from a `--debug` log. Hetzner's errors carry an empty
# <Message/>, and aws-cli crashes formatting one before it prints the code — which was all a failed
# upload ever showed (2026-09-13).
code_in() {
  local c
  c=$(grep -o '<Code>[^<]*</Code>' "$1" | head -n 1 | sed -e 's/<[^>]*>//g') || true
  if [ -n "$c" ]; then echo "$c"; else grep -v DEBUG "$1" | tail -n 1; fi
}
works() {
  local label=$1
  shift
  if "$@" --debug >/dev/null 2>"$SCRATCH/err"; then
    pass "$label"
  else
    fail "$label — $(code_in "$SCRATCH/err")"
  fi
}
# A refusal counts only when it IS a refusal: AccessDenied, or UnauthorizedAccess, which is what
# Hetzner answers for deleting a bucket. Anything else means the request never reached the policy.
# The code is read from the raw response (`--debug`): Hetzner sends refusals with an empty
# <Message/>, and aws-cli crashes formatting that error before it prints the code (2026-09-12).
refused() {
  local label=$1 out code
  shift
  if out=$("$@" --debug 2>&1); then
    fail "$label — ACCEPTED, should have been refused"
    return
  fi
  code=$(grep -o '<Code>[^<]*</Code>' <<<"$out" | head -n 1 | sed -e 's/<[^>]*>//g') || true
  if [ -z "$code" ]; then
    code=$(grep -o 'An error occurred ([A-Za-z]*)' <<<"$out" | head -n 1 | sed -e 's/.*(\(.*\))/\1/') ||
      true
  fi
  case "$code" in
    AccessDenied | UnauthorizedAccess) pass "$label — refused ($code)" ;;
    "") fail "$label — failed without an error code: $(grep -v DEBUG <<<"$out" | tail -n 1)" ;;
    *) fail "$label — failed with $code, which is not a refusal: $(grep -v DEBUG <<<"$out" | tail -n 1)" ;;
  esac
}

# A public upload by the multipart route. On this storage the policy's x-amz-acl condition is not
# applied when a multipart upload BEGINS (seen 2026-09-13 in fsn1: accepted; the plain upload was
# refused), so what is checked is what matters: whether the finished object can be read by anybody.
# If it can, it is deleted at once and the check fails.
public_multipart() {
  local mkey="check/public-multipart-$STAMP.txt" upload etag code
  upload=$(aws s3api create-multipart-upload --bucket "$BUCKET" --key "$mkey" --acl public-read \
    --query UploadId --output text 2>/dev/null) || upload=
  if [ -z "$upload" ] || [ "$upload" = None ]; then
    pass "a public multipart upload — refused when it begins"
    return
  fi
  etag=$(aws s3api upload-part --bucket "$BUCKET" --key "$mkey" --upload-id "$upload" \
    --part-number 1 --body "$SCRATCH/probe.txt" --query ETag --output text 2>/dev/null) || etag=
  if [ -z "$etag" ] || [ "$etag" = None ]; then
    pass "a public multipart upload — begun, but no part accepted (the lifecycle aborts it)"
    return
  fi
  jq -n --arg e "$etag" '{Parts: [{ETag: $e, PartNumber: 1}]}' >"$SCRATCH/parts.json"
  if ! aws s3api complete-multipart-upload --bucket "$BUCKET" --key "$mkey" --upload-id "$upload" \
    --multipart-upload "file://$SCRATCH/parts.json" >/dev/null 2>&1; then
    pass "a public multipart upload — begun, but never completed (the lifecycle aborts it)"
    return
  fi
  code=$(curl -s -o /dev/null -w '%{http_code}' "https://$BUCKET.$LOCATION.your-objectstorage.com/$mkey")
  aws s3api delete-object --bucket "$BUCKET" --key "$mkey" >/dev/null 2>&1 || true
  if [ "$code" = 403 ]; then
    pass "a public multipart upload — accepted, yet nobody can read what it made (403)"
  else
    fail "a public multipart upload — the finished object answered $code to anybody (now deleted)"
  fi
}

echo "$(aws --version 2>&1 | cut -d' ' -f1) → $BUCKET ($LOCATION)"

# ── the CRM's key: what it must be able to do ────────────────────────────────
say "The CRM's key works"
as_app
works "list the bucket" aws s3api list-objects-v2 --bucket "$BUCKET" --max-keys 1

# The upload is also the positive control: it proves this client signs requests the storage
# accepts, so a refusal below is the policy speaking and not a signing fault.
VERSION=$(aws s3api put-object --bucket "$BUCKET" --key "$KEY" --body "$SCRATCH/probe.txt" \
  --query VersionId --output text --debug 2>"$SCRATCH/err") || true
if [ -n "$VERSION" ] && [ "$VERSION" != None ]; then
  pass "upload — stored as a new version"
else
  fail "upload — $(code_in "$SCRATCH/err")"
  echo "   Nothing else can be checked without an upload. Send this output." >&2
  exit 1
fi
if aws s3api get-object --bucket "$BUCKET" --key "$KEY" "$SCRATCH/back.txt" --debug >/dev/null \
  2>"$SCRATCH/err" && cmp -s "$SCRATCH/probe.txt" "$SCRATCH/back.txt"; then
  pass "read it back, byte for byte"
else
  fail "read it back — $(code_in "$SCRATCH/err")"
fi

# ── the backup's key: it only reads ──────────────────────────────────────────
say "The backup's key only reads"
as_backup
works "list the bucket" aws s3api list-objects-v2 --bucket "$BUCKET" --max-keys 1
if aws s3api get-object --bucket "$BUCKET" --key "$KEY" "$SCRATCH/mirror.txt" --debug >/dev/null \
  2>"$SCRATCH/err" && cmp -s "$SCRATCH/probe.txt" "$SCRATCH/mirror.txt"; then
  pass "read what the CRM stored, byte for byte — the nightly copy can"
else
  fail "read what the CRM stored — $(code_in "$SCRATCH/err")"
fi
status=$(aws s3api get-bucket-versioning --bucket "$BUCKET" --query Status --output text 2>/dev/null) ||
  status=unreadable
if [ "$status" = Enabled ]; then pass "versioning reads Enabled"; else fail "versioning reads '$status'"; fi
refused "upload" aws s3api put-object --bucket "$BUCKET" --key "check/backup-$STAMP.txt" \
  --body "$SCRATCH/probe.txt"
refused "a plain delete" aws s3api delete-object --bucket "$BUCKET" --key "$KEY"
# `--version-id=`, never a space: a version id may begin with a dash, which aws-cli then reads as
# an option of its own and fails with ParamValidation (second run, 2026-09-13)
refused "read by version" aws s3api get-object --bucket "$BUCKET" --key "$KEY" \
  --version-id="$VERSION" "$SCRATCH/by-version.txt"
refused "list the versions" aws s3api list-object-versions --bucket "$BUCKET" --prefix check/
refused "rewrite the policy" aws s3api put-bucket-policy --bucket "$BUCKET" --policy 'not a policy'
refused "delete the bucket" aws s3api delete-bucket --bucket "$BUCKET"

# ── the CRM's key: what it must not ──────────────────────────────────────────
say "The CRM's key cannot destroy history or change the rules"
as_app
code=$(curl -s -o /dev/null -w '%{http_code}' "https://$BUCKET.$LOCATION.your-objectstorage.com/$KEY")
if [ "$code" = 403 ]; then pass "an anonymous read — refused"; else fail "an anonymous read answered $code, not 403"; fi

refused "change an object's ACL" aws s3api put-object-acl --bucket "$BUCKET" --key "$KEY" --acl private
refused "a public upload" aws s3api put-object --bucket "$BUCKET" --key "check/public-$STAMP.txt" \
  --body "$SCRATCH/probe.txt" --acl public-read
public_multipart
refused "rewrite the policy" aws s3api put-bucket-policy --bucket "$BUCKET" --policy 'not a policy'
refused "switch versioning" aws s3api put-bucket-versioning --bucket "$BUCKET" \
  --versioning-configuration Status=Enabled
refused "rewrite the lifecycle" aws s3api put-bucket-lifecycle-configuration --bucket "$BUCKET" \
  --lifecycle-configuration file://lifecycle-files.json
# the block setup-bucket.sh puts on is what stops a public multipart upload; a key that could lift it
# would undo that. It is re-sent as it stands, so were it accepted nothing would change.
refused "change the public access block" aws s3api put-public-access-block --bucket "$BUCKET" \
  --public-access-block-configuration \
  BlockPublicAcls=false,IgnorePublicAcls=true,BlockPublicPolicy=false,RestrictPublicBuckets=false
refused "delete the bucket" aws s3api delete-bucket --bucket "$BUCKET"

works "a plain delete — it only hides the object" aws s3api delete-object --bucket "$BUCKET" --key "$KEY"
refused "delete that version for good" aws s3api delete-object --bucket "$BUCKET" --key "$KEY" \
  --version-id="$VERSION"

if [ -n "$OTHER_BUCKET" ]; then
  other=(--endpoint-url "https://$OTHER_LOCATION.your-objectstorage.com" --region "$OTHER_LOCATION")
  refused "list $OTHER_BUCKET" aws s3api list-objects-v2 --bucket "$OTHER_BUCKET" --max-keys 1 "${other[@]}"
  refused "upload into $OTHER_BUCKET" aws s3api put-object --bucket "$OTHER_BUCKET" \
    --key "check/probe-$STAMP.txt" --body "$SCRATCH/probe.txt" "${other[@]}"
fi

# ── verdict ──────────────────────────────────────────────────────────────────
say "Result: $PASSED passed, $FAILED failed"
if [ "$FAILED" -eq 0 ]; then
  echo "   The files bucket does what its policy says."
else
  echo "   Something is not as designed. Send this output — it holds no secret." >&2
  exit 1
fi
