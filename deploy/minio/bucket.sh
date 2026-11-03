#!/bin/sh
# The bucket of a deployment (README.md "Production"), run by the one-shot service minio-setup before
# the api: S3_BUCKET, created when missing by an S3 request the Temporal image's curl signs with
# MinIO's root user, as scripts/env.sh does. 409 is MinIO's answer for a bucket that exists already.
set -eu
[ -n "$S3_BUCKET" ] || { echo "minio-setup: S3_BUCKET is empty in deploy/.env" >&2; exit 1; }
status="$(curl -s --max-time 10 -o /dev/null -w '%{http_code}' --aws-sigv4 aws:amz:us-east-1:s3 \
  --user "$S3_KEY:$S3_SECRET" -X PUT "http://minio:9000/$S3_BUCKET/")"
case "$status" in
  200) echo "minio-setup: bucket $S3_BUCKET created" ;;
  409) echo "minio-setup: bucket $S3_BUCKET exists" ;;
  *) echo "minio-setup: MinIO answered HTTP $status for the bucket $S3_BUCKET" >&2; exit 1 ;;
esac
