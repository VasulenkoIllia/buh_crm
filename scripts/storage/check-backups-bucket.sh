#!/usr/bin/env bash
#
# Prove, with the backup key itself, that a backups bucket does what its policy says — before any
# real data goes into it.
#
#   ./scripts/storage/check-backups-bucket.sh <bucket> <location> [<other-bucket> <other-location>]
#
# It asks for the BACKUP key — the one the server will hold, minted in its own project — and checks:
#   works    list, upload, read back, versioning reads Enabled, and (with restic installed) a
#            throwaway restic repository: init, two backups, restore, forget --prune, check
#   refused  deleting a version for good, rewriting the policy / versioning / lifecycle, deleting
#            the bucket, changing an ACL, a public upload, an anonymous read — and the other bucket
#
# Every probe is harmless even if it were wrongly accepted: the policy probe sends a body that is
# not JSON, versioning and lifecycle are re-sent unchanged, the bucket is not empty, the ACL asked
# for is `private`. The probes leave a few hidden objects under check/ that the key cannot remove —
# that is the point — and the lifecycle deletes them after 90 days.
#
# Nothing here names a real bucket or key: this repository is public.

set -euo pipefail
SELF="$(cd "$(dirname "$0")" && pwd)/$(basename "$0")"
cd "$(dirname "$SELF")"

usage() { sed -n '2,19p' "$SELF" | sed 's/^# \{0,1\}//'; exit 2; }
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
for tool in aws jq curl openssl; do
  command -v "$tool" >/dev/null || { echo "$tool is missing" >&2; exit 1; }
done
HAVE_RESTIC=false
command -v restic >/dev/null && HAVE_RESTIC=true

# ── the backup key ───────────────────────────────────────────────────────────
printf 'The BACKUP key — from its own project, not a temporary one\n  access key: ' >&2
# `|| true`: at end of input `read` fails, and `set -e` would end the script without a word
read -r AWS_ACCESS_KEY_ID || true
printf '  secret (not shown): ' >&2
read -rs AWS_SECRET_ACCESS_KEY || true
printf '\n' >&2
[ -n "$AWS_ACCESS_KEY_ID" ] && [ -n "$AWS_SECRET_ACCESS_KEY" ] || { echo "no key given" >&2; exit 2; }
export AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY
unset AWS_PROFILE AWS_SESSION_TOKEN
export AWS_CONFIG_FILE=/dev/null AWS_SHARED_CREDENTIALS_FILE=/dev/null
export AWS_DEFAULT_REGION="$LOCATION" AWS_ENDPOINT_URL="https://$LOCATION.your-objectstorage.com"
export AWS_REQUEST_CHECKSUM_CALCULATION=when_required AWS_RESPONSE_CHECKSUM_VALIDATION=when_required

SCRATCH=$(mktemp -d)
trap 'rm -rf "$SCRATCH"' EXIT
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
KEY="check/probe-$STAMP.txt"
printf 'buh_crm bucket check %s\n' "$STAMP" >"$SCRATCH/probe.txt"

PASSED=0
FAILED=0
say() { printf '\n\033[1m▸ %s\033[0m\n' "$1"; }
pass() { printf '   \033[32m✓\033[0m %s\n' "$1"; PASSED=$((PASSED + 1)); }
fail() { printf '   \033[31m✗\033[0m %s\n' "$1"; FAILED=$((FAILED + 1)); }
works() {
  local label=$1 out
  shift
  if out=$("$@" 2>&1); then pass "$label"; else fail "$label — $(tail -n 1 <<<"$out")"; fi
}
# A refusal counts only when it IS a refusal: the storage's own error code is AccessDenied — or
# UnauthorizedAccess, which is what Hetzner answers for deleting a bucket. Anything else, a
# signature error or BucketNotEmpty, means the request never reached the policy at all.
#
# The code is read from the raw response (`--debug`), not from the CLI's message. Hetzner sends
# refusals with an empty <Message/>, and aws-cli then crashes while formatting the error —
# "argument of type 'NoneType' is not a container or iterable" — before it ever prints the code
# (first run, 2026-09-12).
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
    *) fail "$label — failed with $code, which is not a refusal" ;;
  esac
}

echo "$(aws --version 2>&1 | cut -d' ' -f1) → $BUCKET ($LOCATION)"

# ── what the key must be able to do ──────────────────────────────────────────
say "The backup key works"
works "list the bucket" aws s3api list-objects-v2 --bucket "$BUCKET" --max-keys 1

# The upload is also the positive control: it proves this client signs requests the storage
# accepts, so a refusal below is the policy speaking and not a signing fault.
VERSION=$(aws s3api put-object --bucket "$BUCKET" --key "$KEY" --body "$SCRATCH/probe.txt" \
  --query VersionId --output text 2>"$SCRATCH/err") || true
if [ -n "$VERSION" ] && [ "$VERSION" != None ]; then
  pass "upload — stored as a new version"
else
  fail "upload — $(tail -n 1 "$SCRATCH/err")"
  echo "   Nothing else can be checked without an upload. Send this output." >&2
  exit 1
fi

if aws s3api get-object --bucket "$BUCKET" --key "$KEY" "$SCRATCH/back.txt" >/dev/null 2>"$SCRATCH/err" &&
  cmp -s "$SCRATCH/probe.txt" "$SCRATCH/back.txt"; then
  pass "read it back, byte for byte"
else
  fail "read it back — $(tail -n 1 "$SCRATCH/err")"
fi

status=$(aws s3api get-bucket-versioning --bucket "$BUCKET" --query Status --output text 2>/dev/null) ||
  status=unreadable
if [ "$status" = Enabled ]; then pass "versioning reads Enabled"; else fail "versioning reads '$status'"; fi

# ── what it must not ─────────────────────────────────────────────────────────
say "The backup key cannot destroy history or change the rules"
code=$(curl -s -o /dev/null -w '%{http_code}' "https://$BUCKET.$LOCATION.your-objectstorage.com/$KEY")
if [ "$code" = 403 ]; then pass "an anonymous read — refused"; else fail "an anonymous read answered $code, not 403"; fi

refused "change an object's ACL" aws s3api put-object-acl --bucket "$BUCKET" --key "$KEY" --acl private
refused "a public upload" aws s3api put-object --bucket "$BUCKET" --key "check/public-$STAMP.txt" \
  --body "$SCRATCH/probe.txt" --acl public-read
# the same, by the multipart route restic uses for large packs — were it accepted, the unfinished
# upload is aborted by the lifecycle after seven days
refused "a public multipart upload" aws s3api create-multipart-upload --bucket "$BUCKET" \
  --key "check/public-multipart-$STAMP.txt" --acl public-read
refused "rewrite the policy" aws s3api put-bucket-policy --bucket "$BUCKET" --policy 'not a policy'
refused "switch versioning" aws s3api put-bucket-versioning --bucket "$BUCKET" \
  --versioning-configuration Status=Enabled
refused "rewrite the lifecycle" aws s3api put-bucket-lifecycle-configuration --bucket "$BUCKET" \
  --lifecycle-configuration file://lifecycle-backups.json
refused "delete the bucket" aws s3api delete-bucket --bucket "$BUCKET"

works "a plain delete — it only hides the object" aws s3api delete-object --bucket "$BUCKET" --key "$KEY"
refused "delete that version for good" aws s3api delete-object --bucket "$BUCKET" --key "$KEY" \
  --version-id "$VERSION"
still=$(aws s3api list-object-versions --bucket "$BUCKET" --prefix "$KEY" 2>/dev/null |
  jq --arg v "$VERSION" '[.Versions[]? | select(.VersionId == $v)] | length') || still=0
if [ "$still" = 1 ]; then pass "the hidden version is still there"; else fail "the hidden version is gone"; fi

if [ -n "$OTHER_BUCKET" ]; then
  other=(--endpoint-url "https://$OTHER_LOCATION.your-objectstorage.com" --region "$OTHER_LOCATION")
  refused "list $OTHER_BUCKET" aws s3api list-objects-v2 --bucket "$OTHER_BUCKET" --max-keys 1 "${other[@]}"
  refused "upload into $OTHER_BUCKET" aws s3api put-object --bucket "$OTHER_BUCKET" \
    --key "check/probe-$STAMP.txt" --body "$SCRATCH/probe.txt" "${other[@]}"
fi

# ── restic, the way the server will use it ───────────────────────────────────
if $HAVE_RESTIC; then
  say "restic, end to end, in a throwaway repository"
  export RESTIC_REPOSITORY="s3:https://$LOCATION.your-objectstorage.com/$BUCKET/check/restic-$STAMP"
  # a password nobody keeps: the repository is thrown away below
  RESTIC_PASSWORD=$(openssl rand -hex 24)
  export RESTIC_PASSWORD
  mkdir -p "$SCRATCH/src" "$SCRATCH/restored"
  printf 'the first night\n' >"$SCRATCH/src/a.txt"
  works "init" restic init
  works "a first backup" restic backup --quiet --host check "$SCRATCH/src"
  printf 'the second night\n' >"$SCRATCH/src/b.txt"
  works "a second backup" restic backup --quiet --host check "$SCRATCH/src"
  works "restore the latest" restic restore latest --target "$SCRATCH/restored"
  back=$(find "$SCRATCH/restored" -type d -name src | head -n 1) || true
  if [ -n "$back" ] && diff -r "$SCRATCH/src" "$back" >/dev/null; then
    pass "what came back is what went in"
  else
    fail "what came back differs from what went in"
  fi
  works "forget one, prune" restic forget --quiet --keep-last 1 --prune
  works "check the repository" restic check --quiet

  # Hidden one by one — plain deletes, which the key may do; the lifecycle removes them in 90 days.
  hidden=0
  while read -r obj; do
    [ -n "$obj" ] || continue
    aws s3api delete-object --bucket "$BUCKET" --key "$obj" >/dev/null && hidden=$((hidden + 1))
  done < <(aws s3api list-objects-v2 --bucket "$BUCKET" --prefix "check/restic-$STAMP/" \
    --query 'Contents[].Key' --output json 2>/dev/null | jq -r '.[]?')
  echo "   (the throwaway repository: $hidden objects hidden)"
else
  say "restic — skipped: brew install restic, then run this again"
fi

# ── verdict ──────────────────────────────────────────────────────────────────
say "Result: $PASSED passed, $FAILED failed"
if [ "$FAILED" -eq 0 ]; then
  echo "   The bucket does what its policy says."
else
  echo "   Something is not as designed. Send this output — it holds no secret." >&2
  exit 1
fi
