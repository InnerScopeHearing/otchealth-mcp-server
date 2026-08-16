/**
 * Application Load Balancer for the gateway. Verified live 2026-08-16 (ELBv2
 * DescribeLoadBalancers / DescribeTargetGroups / DescribeListeners / DescribeRules).
 */

resource "aws_lb" "gateway" {
  name               = "otchealth-gateway"
  internal           = false
  load_balancer_type = "application"
  ip_address_type    = "ipv4"

  security_groups = [aws_security_group.alb_public.id]
  subnets         = local.gateway_subnet_ids
}

resource "aws_lb_target_group" "gateway" {
  name        = "otchealth-gateway-tg"
  port        = 8080
  protocol    = "HTTP"
  target_type = "ip"
  vpc_id      = data.aws_vpc.main.id

  health_check {
    protocol            = "HTTP"
    path                = "/health"
    interval            = 30
    timeout             = 5
    healthy_threshold   = 2
    unhealthy_threshold = 2
    matcher             = "200"
  }
}

# Port 80: redirect everything to 443. Verified live -- StatusCode HTTP_301, Path "/#{path}",
# Query "#{query}", Host "#{host}" (i.e. an exact-passthrough redirect, not a fixed target).
resource "aws_lb_listener" "http_redirect" {
  load_balancer_arn = aws_lb.gateway.arn
  port              = 80
  protocol          = "HTTP"

  default_action {
    type = "redirect"
    redirect {
      port        = "443"
      protocol    = "HTTPS"
      status_code = "HTTP_301"
    }
  }
}

# Port 443: forward to the gateway target group.
resource "aws_lb_listener" "https" {
  load_balancer_arn = aws_lb.gateway.arn
  port              = 443
  protocol          = "HTTPS"
  ssl_policy        = "ELBSecurityPolicy-TLS13-1-2-2021-06"
  certificate_arn   = data.aws_acm_certificate.gateway.arn

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.gateway.arn
  }
}
