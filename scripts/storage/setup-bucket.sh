#!/usr/bin/env bash
#
# Give a bucket the three settings it must have, and read them back: versioning on, the lifecycle
# rules, and the policy that lets exactly its keys in.
#
#   ./scripts/storage/setup-bucket.sh <bucket> <location> <key-project-id> <key-access-id>
#   ./scripts/storage/setup-bucket.sh --files <bucket> <location> \
#       <app-project-id> <app-access-id> <backup-project-id> <backup-access-id>
#
#   (no flag)       a backups bucket: one key, the backup's (policy-backups, lifecycle-backups)
#   --files         the files bucket: the CRM's key reads and writes, the backup's only reads
#                   (policy-files, lifecycle-files, public ACLs ignored; versions kept 30 days)
#   location        fsn1 | nbg1 | hel1 — where the bucket was created
#   *-project-id    the project a key was minted in (the number after /projects/)
#   *-access-id     that key's access key — the public half, never the secret
#
# Run it from the laptop, never from the server. It asks for a TEMPORARY key minted in the
# bucket's own project — the project that otherwise holds no key at all — keeps it in memory, and
# never prints it. Delete that key in the Console when this is done.
#
# Re-running it is also how a rotated key is let in: same bucket, the new access id. The policy
# names keys, not whole projects, because that is the form Hetzner documents.
#
# Nothing here names a real bucket, project or key: this repository is public.

set -euo pipefail
# The absolute path first: `$0` is relative to wherever it was run from, and stops resolving the
# moment the script moves into its own directory to read the templates beside it.
SELF="$(cd "$(dirname "$0")" && pwd)/$(basename "$0")"
cd "$(dirname "$SELF")"

usage() { sed -n '2,24p' "$SELF" | sed 's/^# \{0,1\}//'; exit 2; }
KIND=backups
if [ "${1:-}" = --files ]; then
  KIND=files
  shift
  [ $# -eq 6 ] || usage
else
  [ $# -eq 4 ] || usage
fi
BUCKET=$1
LOCATION=$2
KEY_PROJECT=$3
KEY_ID=$4
BACKUP_PROJECT=${5:-}
BACKUP_KEY_ID=${6:-}

case "$LOCATION" in
  fsn1 | nbg1 | hel1) ;;
  *) echo "location must be fsn1, nbg1 or hel1, not '$LOCATION'" >&2; exit 2 ;;
esac
[[ $BUCKET =~ ^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$ ]] || { echo "not a bucket name: $BUCKET" >&2; exit 2; }
for project in "$KEY_PROJECT" ${BACKUP_PROJECT:+"$BACKUP_PROJECT"}; do
  [[ $project =~ ^[0-9]+$ ]] || { echo "a project id is a number: $project" >&2; exit 2; }
done
for id in "$KEY_ID" ${BACKUP_KEY_ID:+"$BACKUP_KEY_ID"}; do
  [[ $id =~ ^[A-Za-z0-9]+$ ]] || { echo "not an access key id: $id" >&2; exit 2; }
done
if [ "$KIND" = files ]; then
  [ "$KEY_ID" != "$BACKUP_KEY_ID" ] ||
    { echo "the CRM's key and the backup's key must be two different keys" >&2; exit 2; }
  # a key opens every bucket of its own project: the CRM's must never share one with the backup's
  [ "$KEY_PROJECT" != "$BACKUP_PROJECT" ] ||
    { echo "the CRM's key comes from its own project (buhcrm-app), not the backup's" >&2; exit 2; }
fi

for tool in aws jq; do
  command -v "$tool" >/dev/null || { echo "$tool is missing — brew install awscli jq" >&2; exit 1; }
done
aws --version 2>&1 | grep -q '^aws-cli/2\.' || { echo "aws-cli v2 is needed" >&2; exit 1; }

say() { printf '\n\033[1m▸ %s\033[0m\n' "$1"; }

# ── the temporary key ────────────────────────────────────────────────────────
printf "The temporary key of the bucket's own project\n  access key: " >&2
# `|| true`: at end of input `read` fails, and `set -e` would end the script without a word
read -r AWS_ACCESS_KEY_ID || true
printf '  secret (not shown): ' >&2
read -rs AWS_SECRET_ACCESS_KEY || true
printf '\n' >&2
[ -n "$AWS_ACCESS_KEY_ID" ] && [ -n "$AWS_SECRET_ACCESS_KEY" ] || { echo "no key given" >&2; exit 2; }
export AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY

# That key and nothing else: a profile, a config file or a session token from this laptop's own AWS
# setup must not be picked up in its place.
unset AWS_PROFILE AWS_SESSION_TOKEN
export AWS_CONFIG_FILE=/dev/null AWS_SHARED_CREDENTIALS_FILE=/dev/null
export AWS_DEFAULT_REGION="$LOCATION" AWS_ENDPOINT_URL="https://$LOCATION.your-objectstorage.com"
# Since 2025 the CLI adds a checksum to every request by default, which Hetzner's storage engine
# has refused before. Only where the API itself requires one.
export AWS_REQUEST_CHECKSUM_CALCULATION=when_required AWS_RESPONSE_CHECKSUM_VALIDATION=when_required

# ── the policy, filled in ────────────────────────────────────────────────────
# In a temporary file, removed on exit: the filled copy belongs in the password manager, not here.
POLICY=$(mktemp)
trap 'rm -f "$POLICY"' EXIT
if [ "$KIND" = files ]; then
  sed -e "s/<BUCKET>/$BUCKET/g" -e "s/<APP_PROJECT>/$KEY_PROJECT/g" -e "s/<APP_KEY_ID>/$KEY_ID/g" \
    -e "s/<BACKUP_PROJECT>/$BACKUP_PROJECT/g" -e "s/<BACKUP_KEY_ID>/$BACKUP_KEY_ID/g" \
    policy-files.template.json >"$POLICY"
else
  sed -e "s/<BUCKET>/$BUCKET/g" -e "s/<KEY_PROJECT>/$KEY_PROJECT/g" -e "s/<KEY_ID>/$KEY_ID/g" \
    policy-backups.template.json >"$POLICY"
fi
if grep -q '<[A-Z_]*>' "$POLICY"; then echo "a placeholder is left in the policy" >&2; exit 1; fi
jq empty "$POLICY"
LIFECYCLE=lifecycle-$KIND.json

echo "$(aws --version 2>&1 | cut -d' ' -f1) → $AWS_ENDPOINT_URL, bucket $BUCKET ($KIND)"

# ── apply ────────────────────────────────────────────────────────────────────
say "Versioning on — a delete only hides; the hidden version stays until the lifecycle removes it"
aws s3api put-bucket-versioning --bucket "$BUCKET" --versioning-configuration Status=Enabled

say "Lifecycle — this replaces the bucket's whole configuration"
aws s3api put-bucket-lifecycle-configuration --bucket "$BUCKET" \
  --lifecycle-configuration "file://$LIFECYCLE"

if [ "$KIND" = files ]; then
  # The policy alone cannot stop a public object here: this storage does not apply its x-amz-acl
  # condition when a multipart upload begins, and a finished multipart upload marked public-read was
  # readable by anybody (check-files-bucket.sh, 2026-09-13). IgnorePublicAcls closes that: such an
  # object answers 403 to anybody. A public ACL on a plain upload, and any change of an ACL, the
  # policy refuses already.
  #
  # IgnorePublicAcls ALONE, as measured one setting at a time (2026-09-14): with BlockPublicAcls on
  # as well, and with all four on, this storage refused the CRM's own key its uploads, though either
  # of the two alone let them through. The policy settings add nothing: only the bucket's own
  # project may change the policy, and it holds no key. Sent before the policy, so a re-run over a
  # bucket that has one of them on cannot be refused at the policy step.
  say "Public ACLs ignored — nobody can read an object by one, however it was made"
  aws s3api put-public-access-block --bucket "$BUCKET" --public-access-block-configuration \
    BlockPublicAcls=false,IgnorePublicAcls=true,BlockPublicPolicy=false,RestrictPublicBuckets=false
fi

if [ "$KIND" = files ]; then
  say "Policy — the CRM's key reads and writes, the backup's only reads; neither destroys history"
else
  say "Policy — one key in, refused everything that destroys history or changes the rules"
fi
aws s3api put-bucket-policy --bucket "$BUCKET" --policy "file://$POLICY"

# ── read back ────────────────────────────────────────────────────────────────
say "Read back"
status=$(aws s3api get-bucket-versioning --bucket "$BUCKET" --query Status --output text)
echo "   versioning: $status"
[ "$status" = Enabled ] || { echo "   ✗ versioning is not Enabled" >&2; exit 1; }

rules=$(aws s3api get-bucket-lifecycle-configuration --bucket "$BUCKET")
jq -r '.Rules[] | "   lifecycle: \(.ID) (\(.Status))"' <<<"$rules"
# restic shares data between snapshots, and a current file is a client's document: expiring a
# CURRENT version destroys either. Hetzner's own example lifecycle does exactly that — never copy it.
jq -e '[.Rules[] | select(.Expiration.Days != null or .Expiration.Date != null)] | length == 0' \
  <<<"$rules" >/dev/null || { echo "   ✗ a rule expires current versions" >&2; exit 1; }

applied=$(aws s3api get-bucket-policy --bucket "$BUCKET" --query Policy --output text)
if [ "$(jq -S . <<<"$applied")" = "$(jq -S . "$POLICY")" ]; then
  if [ "$KIND" = files ]; then
    echo "   policy: as sent — the CRM's key $KEY_ID (project $KEY_PROJECT) and the backup's"
    echo "           key $BACKUP_KEY_ID (project $BACKUP_PROJECT)"
  else
    echo "   policy: as sent, naming key $KEY_ID of project $KEY_PROJECT"
  fi
else
  echo "   ✗ the policy read back differs from the one sent — read it:" >&2
  jq . <<<"$applied" >&2
  exit 1
fi

if [ "$KIND" = files ]; then
  block=$(aws s3api get-public-access-block --bucket "$BUCKET" \
    --query PublicAccessBlockConfiguration --output json)
  if jq -e '(.BlockPublicAcls | not) and .IgnorePublicAcls and (.BlockPublicPolicy | not) and
      (.RestrictPublicBuckets | not)' <<<"$block" >/dev/null; then
    echo "   public access: public ACLs ignored; the other three settings off"
  else
    echo "   ✗ the public access block is not as sent: $(jq -c . <<<"$block")" >&2
    exit 1
  fi
fi

say "Done"
echo "   Now delete the temporary key: Console → the bucket's project → Security → S3 Credentials."
echo "   That project must list no key afterwards."
echo "   Never press \"Reset visibility/policy\" and never make the bucket public: either removes"
echo "   this policy. The Console's file list may stop working now that a policy is on — expected."
if [ "$KIND" = files ]; then
  echo "   Next, with both real keys: ./scripts/storage/check-files-bucket.sh $BUCKET $LOCATION"
fi
