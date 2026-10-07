# Apply commands below operate ONLY against this mock provider, never AWS.
mock_provider "aws" {}

variables {
  name               = "godiffy-dev"
  vpc_cidr           = "10.42.0.0/16"
  availability_zones = ["eu-west-2a", "eu-west-2b"]
  endpoint_az_count  = 1
  enable_http        = true
  image_bucket_arn   = "arn:aws:s3:::godiffy-dev-images-218549829565-eu-west-2"
  tags               = { Project = "godiffy", Environment = "dev", ManagedBy = "terraform", Purpose = "cloudpay-technical-assessment" }
}

run "dev_private_network" {
  command = apply
  assert {
    condition = (
      length(aws_subnet.public) == 2 && length(aws_subnet.tasks) == 2 && length(aws_subnet.database) == 2 &&
      alltrue([for subnet in aws_subnet.tasks : !subnet.map_public_ip_on_launch]) &&
      alltrue([for subnet in aws_subnet.database : !subnet.map_public_ip_on_launch])
    )
    error_message = "Two AZs must have separate public, private task and isolated DB subnets without automatic public IPs."
  }
  assert {
    condition = (
      aws_route.internet.route_table_id == aws_route_table.public.id &&
      alltrue([for association in aws_route_table_association.database : association.route_table_id == aws_route_table.database.id]) &&
      alltrue([for az, association in aws_route_table_association.tasks : association.route_table_id == aws_route_table.tasks[az].id])
    )
    error_message = "Internet routing must stay separate from task and database routing."
  }
  assert {
    condition = (
      aws_vpc_security_group_ingress_rule.tasks_alb.referenced_security_group_id == aws_security_group.alb.id &&
      aws_vpc_security_group_ingress_rule.tasks_alb.from_port == 3000 &&
      aws_vpc_security_group_ingress_rule.database_tasks.referenced_security_group_id == aws_security_group.tasks.id &&
      aws_vpc_security_group_ingress_rule.database_tasks.from_port == 5432 &&
      aws_vpc_security_group_egress_rule.tasks_endpoints.referenced_security_group_id == aws_security_group.endpoints.id &&
      aws_vpc_security_group_egress_rule.tasks_endpoints.from_port == 443 &&
      aws_vpc_security_group_egress_rule.tasks_database.cidr_ipv4 == null
    )
    error_message = "Application/DB traffic must use exact SG peers and ports, not public ingress/egress."
  }
  assert {
    condition = (
      length(aws_vpc_endpoint.interface) == 4 &&
      alltrue([for endpoint in aws_vpc_endpoint.interface : length(endpoint.subnet_ids) == 1 && endpoint.private_dns_enabled]) &&
      length(aws_vpc_endpoint.s3.route_table_ids) == 2
    )
    error_message = "Dev needs four one-AZ private-DNS endpoints and S3 routing in both task AZs."
  }
  assert {
    condition = contains(
      jsondecode(aws_vpc_endpoint.s3.policy).Statement[1].Resource,
      "arn:aws:s3:::prod-eu-west-2-starport-layer-bucket/*"
    )
    error_message = "ECR pulls require the AWS-owned regional image-layer S3 bucket."
  }
}

run "prod_two_endpoint_azs" {
  command = apply
  variables {
    name              = "godiffy-prod"
    vpc_cidr          = "10.43.0.0/16"
    endpoint_az_count = 2
    enable_http       = false
    image_bucket_arn  = "arn:aws:s3:::godiffy-prod-images-218549829565-eu-west-2"
    tags              = { Project = "godiffy", Environment = "prod", ManagedBy = "terraform", Purpose = "cloudpay-technical-assessment" }
  }
  assert {
    condition = (
      alltrue([for endpoint in aws_vpc_endpoint.interface : length(endpoint.subnet_ids) == 2]) &&
      length(aws_vpc_security_group_ingress_rule.http) == 0
    )
    error_message = "Prod must have endpoints in both AZs and no bootstrap plaintext listener ingress."
  }
}

run "reject_other_project" {
  command = plan
  variables { name = "another-project-dev" }
  expect_failures = [var.name]
}

run "reject_duplicate_azs" {
  command = plan
  variables { availability_zones = ["eu-west-2a", "eu-west-2a"] }
  expect_failures = [var.availability_zones]
}
