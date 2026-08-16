# ─────────────────────────────────────────────────────────────────────────
# APPLICATION LOAD BALANCER
# otchealth-gateway, internet-facing, 3 AZs. Fronts the ECS gateway service.
# Verified live 2026-08-16 (DescribeLoadBalancers / DescribeListeners /
# DescribeTargetGroups / DescribeLoadBalancerAttributes).
#
# NOTE on the 3 "Elastic IPs" you will see if you list EIPs in this account
# (eipalloc-0b36975db34e8a9a6, eipalloc-0c5e53f513dc84a50, eipalloc-0bece05963a825309):
# these are AWS-ELB-MANAGED (requesterManaged=true, requesterId=amazon-elb),
# one per AZ, auto-provisioned BY the internet-facing ALB below. They are NOT
# modeled as `aws_eip` resources here and must never be -- an internet-facing
# `aws_lb` gets these automatically; trying to also manage them as separate
# EIP resources would conflict with the ALB's own management of them.
# ─────────────────────────────────────────────────────────────────────────

# DNS validation for this cert lives outside this AWS account (Cloudflare, per
# fleet convention -- there are zero Route53 hosted zones in this account,
# confirmed live). Looked up read-only by domain rather than imported as a
# managed resource: Terraform cannot re-run DNS validation on apply, so
# treating it as a resource here would just be a certificate ARN, not a real
# rebuild path. If the cert is ever lost, re-issue + re-validate is an ACM +
# Cloudflare-DNS action outside this repo's scope.
data "aws_acm_certificate" "mcp_otchealth_app" {
  domain      = "mcp.otchealth.app"
  statuses    = ["ISSUED"]
  most_recent = true
}

resource "aws_lb" "gateway" {
  name               = "otchealth-gateway"
  internal           = false
  load_balancer_type = "application"
  ip_address_type    = "ipv4"

  security_groups = [aws_security_group.alb_public.id]
  subnets = [
    data.aws_subnet.a.id,
    data.aws_subnet.b.id,
    data.aws_subnet.f.id,
  ]

  # Live and deliberate: this is what actually stops an accidental `terraform
  # destroy` (or a `create_before_destroy` replace) from taking the ALB out.
  enable_deletion_protection = true

  enable_http2                    = true
  enable_cross_zone_load_balancing = true
  idle_timeout                    = 60
  # All other attributes (access/connection/health-check logs, WAF fail-open,
  # zonal shift, desync mitigation mode) are already at the provider default
  # and were confirmed identical to the live DescribeLoadBalancerAttributes
  # output, so they are left unset here rather than restated.
}

resource "aws_lb_target_group" "gateway" {
  name        = "otchealth-gateway-tg"
  vpc_id      = data.aws_vpc.default.id
  target_type = "ip"
  protocol    = "HTTP"
  port        = 8080

  health_check {
    enabled             = true
    protocol            = "HTTP"
    path                = "/health"
    matcher             = "200"
    healthy_threshold   = 2
    unhealthy_threshold = 2
    interval            = 30
    timeout             = 5
  }
}

resource "aws_lb_listener" "http_redirect" {
  load_balancer_arn = aws_lb.gateway.arn
  protocol          = "HTTP"
  port              = 80

  default_action {
    type = "redirect"
    redirect {
      protocol    = "HTTPS"
      port        = "443"
      status_code = "HTTP_301"
    }
  }
}

resource "aws_lb_listener" "https" {
  load_balancer_arn = aws_lb.gateway.arn
  protocol          = "HTTPS"
  port              = 443
  ssl_policy        = "ELBSecurityPolicy-TLS13-1-2-2021-06"
  certificate_arn   = data.aws_acm_certificate.mcp_otchealth_app.arn

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.gateway.arn
  }
}
