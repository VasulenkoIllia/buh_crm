#!/usr/bin/env bash
#
# Give a backups bucket the three settings it must have, and read them back:
# versioning on, the lifecycle rules, and the policy that lets exactly one key in.
#
#   ./scripts/storage/setup-bucket.sh <bucket> <location> <key-project-id> <key-access-id>
#
#   location        fsn1 | nbg1 | hel1 — where the bucket was created
#   key-project-id  the project the backup key was minted in (the number after /projects/)
#   key-access-id   that key's access key — the public half, never the secret
#
# Run it from the laptop, never from the server. It asks for a TEMPORARY key minted in the
# bucket's own project — the project that otherwise holds no key at all — keeps it in memory, and
# never prints it. Delete that key in the Console when this is done.
#
# Re-running it is also how a rotated backup key is let in: same bucket, the new access id. The
# policy names one key, not the whole project, because that is the form Hetzner documents.
#
# Nothing here names a real bucket, project or key: this repository is public.

set -euo pipefail
# The absolute path first: `$0` is relative to wherever it was run from, and stops resolving the
# moment the script moves into its own directory to read the templates beside it.
SELF="$(cd "$(dirname "$0")" && pwd)/$(basename "$0")"
cd "$(dirname "$SELF")"

usage() { sed -n '2,19p' "$SELF" | sed 's/^# \{0,1\}//'; exit 2; }
[ $# -eq 4 ] || usage
BUCKET=$1
LOCATION=$2
KEY_PROJECT=$3
KEY_ID=$4

case "$LOCATION" in
  fsn1 | nbg1 | hel1) ;;
  *) echo "location must be fsn1, nbg1 or hel1, not '$LOCATION'" >&2; exit 2 ;;
esac
[[ $BUCKET =~ ^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$ ]] || { echo "not a bucket name: $BUCKET" >&2; exit 2; }
[[ $KEY_PROJECT =~ ^[0-9]+$ ]] || { echo "the project id is a number: $KEY_PROJECT" >&2; exit 2; }
[[ $KEY_ID =~ ^[A-Za-z0-9]+$ ]] || { echo "not an access key id: $KEY_ID" >&2; exit 2; }

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
sed -e "s/<BUCKET>/$BUCKET/g" -e "s/<KEY_PROJECT>/$KEY_PROJECT/g" -e "s/<KEY_ID>/$KEY_ID/g" \
  policy-backups.template.json >"$POLICY"
if grep -q '<[A-Z_]*>' "$POLICY"; then echo "a placeholder is left in the policy" >&2; exit 1; fi
jq empty "$POLICY"

echo "$(aws --version 2>&1 | cut -d' ' -f1) → $AWS_ENDPOINT_URL, bucket $BUCKET"

# ── apply ────────────────────────────────────────────────────────────────────
say "Versioning on — a delete only hides; the hidden version stays until the lifecycle removes it"
aws s3api put-bucket-versioning --bucket "$BUCKET" --versioning-configuration Status=Enabled

say "Lifecycle — this replaces the bucket's whole configuration"
aws s3api put-bucket-lifecycle-configuration --bucket "$BUCKET" \
  --lifecycle-configuration file://lifecycle-backups.json

say "Policy — one key in, refused everything that destroys history or changes the rules"
aws s3api put-bucket-policy --bucket "$BUCKET" --policy "file://$POLICY"

# ── read back ────────────────────────────────────────────────────────────────
say "Read back"
status=$(aws s3api get-bucket-versioning --bucket "$BUCKET" --query Status --output text)
echo "   versioning: $status"
[ "$status" = Enabled ] || { echo "   ✗ versioning is not Enabled" >&2; exit 1; }

rules=$(aws s3api get-bucket-lifecycle-configuration --bucket "$BUCKET")
jq -r '.Rules[] | "   lifecycle: \(.ID) (\(.Status))"' <<<"$rules"
# restic shares data between snapshots: expiring a CURRENT version deletes data a kept snapshot
# still needs. Hetzner's own example lifecycle does exactly that — never copy it.
jq -e '[.Rules[] | select(.Expiration.Days != null or .Expiration.Date != null)] | length == 0' \
  <<<"$rules" >/dev/null || { echo "   ✗ a rule expires current versions" >&2; exit 1; }

applied=$(aws s3api get-bucket-policy --bucket "$BUCKET" --query Policy --output text)
if [ "$(jq -S . <<<"$applied")" = "$(jq -S . "$POLICY")" ]; then
  echo "   policy: as sent, naming key $KEY_ID of project $KEY_PROJECT"
else
  echo "   ✗ the policy read back differs from the one sent — read it:" >&2
  jq . <<<"$applied" >&2
  exit 1
fi

say "Done"
echo "   Now delete the temporary key: Console → the bucket's project → Security → S3 Credentials."
echo "   That project must list no key afterwards."
echo "   Never press \"Reset visibility/policy\" and never make the bucket public: either removes"
echo "   this policy. The Console's file list may stop working now that a policy is on — expected."
