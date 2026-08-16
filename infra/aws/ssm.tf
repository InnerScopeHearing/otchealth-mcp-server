/**
 * SSM Parameter Store -- DELIBERATELY NOT MODELED AS TERRAFORM RESOURCES. Read this before adding
 * an aws_ssm_parameter block to this directory.
 *
 * Verified live 2026-08-16 (SSM DescribeParameters, paginated, under /otchealth/): exactly 444
 * parameters (438 SecureString, 6 String; 440 Standard tier, 4 Advanced -- the ones over 4KB).
 * NAMES and metadata (type, tier, version, lastModifiedDate) are captured in
 * data/ssm-parameter-inventory.json -- generated ONLY via DescribeParameters, an API call that
 * cannot return a parameter's value under any circumstance (contrast with GetParameter/
 * GetParametersByPath, which this capture never called). Zero values anywhere in this repo.
 *
 * WHY NOT `resource "aws_ssm_parameter"` FOR EACH ONE: the provider's schema requires a `value`
 * argument on this resource type, and on refresh/import it reads the CURRENT value from AWS
 * (decrypting SecureString) into the LOCAL STATE FILE in plaintext -- this is a known, structural
 * property of the resource, not a configuration mistake that can be avoided with
 * `lifecycle.ignore_changes` or `sensitive = true` (those only affect what Terraform PRINTS, not
 * what it WRITES to state). Declaring 444 of these -- 438 of them SecureString -- would mean
 * running `terraform import` on this directory writes 438 real secret values into a local file.
 * That is an unacceptable outcome for a capture exercise built around "never put a secret value
 * in code," so this directory does not do it, full stop.
 *
 * Every place a secret is actually NEEDED, it is referenced by ARN STRING ONLY -- never fetched,
 * never decrypted, never stored -- exactly the ECS `secrets[].valueFrom` pattern already used
 * throughout ecs-gateway.tf and ecs-jobs.tf (both generated from data files that only ever
 * contain `{name, valueFrom}` pairs). Parameter VALUES stay entirely externally managed: rotated
 * and populated out-of-band (this repo's own convention -- see the fleet's `set-secret.mjs`
 * equivalent tooling), never through `terraform apply`.
 *
 * If SSM parameter METADATA (not value) is ever worth managing declaratively -- e.g. enforcing a
 * naming/tagging standard across all 444 -- the safe pattern is a data source
 * (`data "aws_ssm_parameter"` with `with_decryption = false`, which returns the CIPHERTEXT for a
 * SecureString rather than the plaintext) used ONLY to read `.arn`/`.name`/`.type`, never `.value`.
 * That is still not done here because it still performs 444 live API calls on every plan for
 * zero infrastructure benefit (nothing about these parameters' EXISTENCE needs managing -- they
 * are provisioned once, out-of-band, exactly like the RDS password in rds.tf).
 */

locals {
  ssm_parameter_inventory = jsondecode(file("${path.module}/data/ssm-parameter-inventory.json"))
}
