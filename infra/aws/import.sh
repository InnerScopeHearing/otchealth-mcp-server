#!/usr/bin/env bash
# import.sh -- the convenience wrapper for THIS directory's capture, not a `terraform import` CLI
# loop. The actual import mapping lives in imports.tf as native `import` blocks (Terraform >=
# 1.7), which `terraform plan` evaluates read-only -- see imports.tf's header for why that is
# deliberately safer than a script full of `terraform import <addr> <id>` commands.
#
# This script therefore does exactly three things, none of which can mutate AWS or write real
# infrastructure state: init (download providers), validate (syntax + internal consistency), and
# plan (show what every import block above would adopt, and flag anything that does not match
# this configuration). It NEVER runs `terraform apply` -- per this task's explicit instruction,
# nothing in this directory does, and this script does not either.
#
# Prerequisites: terraform >= 1.7.0 on PATH, and AWS credentials for account 900915535335
# (`aws sts get-caller-identity` should show that account) exported in the environment or via a
# configured profile. This was NEVER RUN during capture (no terraform binary was available in the
# sandbox this was written in -- see README.md "What is NOT verified").

set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

echo "== terraform init =="
terraform init

echo "== terraform validate =="
terraform validate

echo "== terraform plan (import blocks only; this NEVER applies) =="
terraform plan -out=/dev/null

echo
echo "Review the plan output above. Every resource should show as importing with an EMPTY diff"
echo "(config matches live state) or a SMALL, deliberate diff (something this capture got wrong"
echo "or something that changed in AWS since 2026-08-16). A resource showing as create-new"
echo "instead of import means its import block's id did not match -- stop and fix the mapping in"
echo "imports.tf before ever running apply."
