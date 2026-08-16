/**
 * ACM certificate for mcp.otchealth.app. Verified live 2026-08-16 (ACM DescribeCertificate):
 * AWS_MANAGED, DNS-validated, ISSUED, in use by exactly the gateway ALB. DNS validation and
 * certificate issuance are NOT idempotent/re-runnable infrastructure actions in the way a
 * security-group rule is -- re-requesting a cert is a real-world action (new validation CNAME,
 * new cert ARN) that would NOT match the currently-deployed one. This is a READ-ONLY data source
 * for exactly that reason: the cert must be ADOPTED (imported) as-is, never recreated.
 */

data "aws_acm_certificate" "gateway" {
  domain      = "mcp.otchealth.app"
  statuses    = ["ISSUED"]
  most_recent = true
}
