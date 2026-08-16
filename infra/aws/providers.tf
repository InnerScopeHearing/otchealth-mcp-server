provider "aws" {
  region = var.aws_region

  # Belt-and-suspenders: refuse to apply against any account other than the one this capture was
  # taken from. If this repo is ever pointed at a different set of credentials, fail loudly instead
  # of silently planning to create a second, divergent copy of the estate.
  allowed_account_ids = [var.aws_account_id]

  # Deliberately NO `default_tags` block. The live resources were not built with a consistent tagging
  # scheme (most carry zero tags; a couple carry one ad hoc `purpose` or `Project`/`Owner` tag) -- see
  # each resource below for the exact tags captured. Injecting a new default-tags scheme here would
  # make the very first `terraform plan` show a tag diff on almost every resource, which works against
  # this repo's goal of importing cleanly with a minimal, honest diff. Add default_tags deliberately,
  # later, as a real decision -- not as a side effect of writing this file.
}
