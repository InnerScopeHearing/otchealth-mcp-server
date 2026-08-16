/**
 * Amazon OpenSearch Service domain -- "the brain". Verified live 2026-08-16
 * (DescribeDomain). OpenSearch_2.19, r6g.large.search x1, gp3 100GB (3000 IOPS / 125 MB/s
 * throughput), NO dedicated master, NO zone awareness (single-AZ effectively, matching a single
 * data node), PUBLIC endpoint (VPCOptions is null -- not VPC-attached; access is controlled by
 * the resource-based AccessPolicies below plus SigV4 signing, not network isolation), encrypted
 * at rest (own KMS key) + node-to-node encryption, HTTPS-only (TLS-1.2-2019-07 policy), no
 * fine-grained access control / Cognito / SAML / IAM Identity Center (auth is plain SigV4 IAM
 * identity via the access policy below).
 */

resource "aws_opensearch_domain" "brain" {
  domain_name    = "otchealth-brain"
  engine_version = "OpenSearch_2.19"

  cluster_config {
    instance_type            = "r6g.large.search"
    instance_count            = 1
    dedicated_master_enabled  = false
    zone_awareness_enabled    = false
    warm_enabled               = false
    multi_az_with_standby_enabled = false
  }

  ebs_options {
    ebs_enabled = true
    volume_type = "gp3"
    volume_size = 100
    iops        = 3000
    throughput  = 125
  }

  encrypt_at_rest {
    enabled    = true
    kms_key_id = "arn:aws:kms:${var.aws_region}:${var.aws_account_id}:key/e51d50f3-d2b8-482c-9f78-42dba210db83"
  }

  node_to_node_encryption {
    enabled = true
  }

  domain_endpoint_options {
    enforce_https       = true
    tls_security_policy = "Policy-Min-TLS-1-2-2019-07"
  }

  advanced_security_options {
    enabled = false
  }

  advanced_options = {
    "override_main_response_version"        = "false"
    "rest.action.multi.allow_explicit_index" = "true"
  }

  off_peak_window_options {
    enabled = true
    off_peak_window {
      window_start_time {
        hours   = 2
        minutes = 0
      }
    }
  }

  # SigV4 IAM identity is the ONLY access control (no VPC attachment): any principal in this
  # account can call es:* against this domain if their own IAM policy also allows it (see
  # otchealthTaskRole's runtime-access policy in iam.tf, scoped to the domain ARN). Verified
  # verbatim from the live AccessPolicies document.
  access_policies = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { AWS = "arn:aws:iam::${var.aws_account_id}:root" }
      Action    = "es:*"
      Resource  = "arn:aws:es:${var.aws_region}:${var.aws_account_id}:domain/otchealth-brain/*"
    }]
  })
}
