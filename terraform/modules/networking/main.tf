locals {
  azs                = { for index, az in var.availability_zones : az => index }
  interface_services = toset(["ecr.api", "ecr.dkr", "logs", "secretsmanager"])
}

resource "aws_vpc" "this" {
  cidr_block           = var.vpc_cidr
  enable_dns_support   = true
  enable_dns_hostnames = true
  tags                 = merge(var.tags, { Name = "${var.name}-vpc" })
}

resource "aws_internet_gateway" "this" {
  vpc_id = aws_vpc.this.id
  tags   = merge(var.tags, { Name = "${var.name}-igw" })
}

resource "aws_subnet" "public" {
  for_each                = local.azs
  vpc_id                  = aws_vpc.this.id
  availability_zone       = each.key
  cidr_block              = cidrsubnet(var.vpc_cidr, 8, each.value)
  map_public_ip_on_launch = false
  tags                    = merge(var.tags, { Name = "${var.name}-public-${each.key}" })
}

resource "aws_subnet" "tasks" {
  for_each                = local.azs
  vpc_id                  = aws_vpc.this.id
  availability_zone       = each.key
  cidr_block              = cidrsubnet(var.vpc_cidr, 8, each.value + 10)
  map_public_ip_on_launch = false
  tags                    = merge(var.tags, { Name = "${var.name}-tasks-${each.key}" })
}

resource "aws_subnet" "database" {
  for_each                = local.azs
  vpc_id                  = aws_vpc.this.id
  availability_zone       = each.key
  cidr_block              = cidrsubnet(var.vpc_cidr, 8, each.value + 20)
  map_public_ip_on_launch = false
  tags                    = merge(var.tags, { Name = "${var.name}-database-${each.key}" })
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.this.id
  tags   = merge(var.tags, { Name = "${var.name}-public" })
}

resource "aws_route" "internet" {
  route_table_id         = aws_route_table.public.id
  destination_cidr_block = "0.0.0.0/0"
  gateway_id             = aws_internet_gateway.this.id
}

resource "aws_route_table_association" "public" {
  for_each       = local.azs
  subnet_id      = aws_subnet.public[each.key].id
  route_table_id = aws_route_table.public.id
}

resource "aws_route_table" "tasks" {
  for_each = local.azs
  vpc_id   = aws_vpc.this.id
  tags     = merge(var.tags, { Name = "${var.name}-tasks-${each.key}" })
}

resource "aws_route_table_association" "tasks" {
  for_each       = local.azs
  subnet_id      = aws_subnet.tasks[each.key].id
  route_table_id = aws_route_table.tasks[each.key].id
}

resource "aws_route_table" "database" {
  vpc_id = aws_vpc.this.id
  tags   = merge(var.tags, { Name = "${var.name}-database-isolated" })
}

resource "aws_route_table_association" "database" {
  for_each       = local.azs
  subnet_id      = aws_subnet.database[each.key].id
  route_table_id = aws_route_table.database.id
}

# No private default routes, NAT gateways, public task IPs or database internet routes.
resource "aws_security_group" "alb" {
  name        = "${var.name}-alb"
  description = "Public listener ingress; only application-port egress to tasks"
  vpc_id      = aws_vpc.this.id
  tags        = merge(var.tags, { Name = "${var.name}-alb" })
}

resource "aws_security_group" "tasks" {
  name        = "${var.name}-tasks"
  description = "ALB-only ingress; database and endpoint-only egress"
  vpc_id      = aws_vpc.this.id
  tags        = merge(var.tags, { Name = "${var.name}-tasks" })
}

resource "aws_security_group" "database" {
  name        = "${var.name}-database"
  description = "PostgreSQL ingress only from Godiffy tasks; no outbound initiation"
  vpc_id      = aws_vpc.this.id
  tags        = merge(var.tags, { Name = "${var.name}-database" })
}

resource "aws_security_group" "endpoints" {
  name        = "${var.name}-endpoints"
  description = "AWS interface endpoint HTTPS ingress only from Godiffy tasks"
  vpc_id      = aws_vpc.this.id
  tags        = merge(var.tags, { Name = "${var.name}-endpoints" })
}

resource "aws_vpc_security_group_ingress_rule" "http" {
  count             = var.enable_http ? 1 : 0
  security_group_id = aws_security_group.alb.id
  description       = "Dev bootstrap HTTP or HTTPS redirect only"
  ip_protocol       = "tcp"
  from_port         = 80
  to_port           = 80
  cidr_ipv4         = "0.0.0.0/0"
  tags              = var.tags
}

resource "aws_vpc_security_group_ingress_rule" "https" {
  security_group_id = aws_security_group.alb.id
  description       = "HTTPS listener for final ACM integration"
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
  cidr_ipv4         = "0.0.0.0/0"
  tags              = var.tags
}

resource "aws_vpc_security_group_egress_rule" "alb_tasks" {
  security_group_id            = aws_security_group.alb.id
  referenced_security_group_id = aws_security_group.tasks.id
  ip_protocol                  = "tcp"
  from_port                    = 3000
  to_port                      = 3000
  tags                         = var.tags
}

resource "aws_vpc_security_group_ingress_rule" "tasks_alb" {
  security_group_id            = aws_security_group.tasks.id
  referenced_security_group_id = aws_security_group.alb.id
  ip_protocol                  = "tcp"
  from_port                    = 3000
  to_port                      = 3000
  tags                         = var.tags
}

resource "aws_vpc_security_group_egress_rule" "tasks_database" {
  security_group_id            = aws_security_group.tasks.id
  referenced_security_group_id = aws_security_group.database.id
  ip_protocol                  = "tcp"
  from_port                    = 5432
  to_port                      = 5432
  tags                         = var.tags
}

resource "aws_vpc_security_group_ingress_rule" "database_tasks" {
  security_group_id            = aws_security_group.database.id
  referenced_security_group_id = aws_security_group.tasks.id
  ip_protocol                  = "tcp"
  from_port                    = 5432
  to_port                      = 5432
  tags                         = var.tags
}

resource "aws_vpc_security_group_egress_rule" "tasks_endpoints" {
  security_group_id            = aws_security_group.tasks.id
  referenced_security_group_id = aws_security_group.endpoints.id
  ip_protocol                  = "tcp"
  from_port                    = 443
  to_port                      = 443
  tags                         = var.tags
}

resource "aws_vpc_security_group_ingress_rule" "endpoints_tasks" {
  security_group_id            = aws_security_group.endpoints.id
  referenced_security_group_id = aws_security_group.tasks.id
  ip_protocol                  = "tcp"
  from_port                    = 443
  to_port                      = 443
  tags                         = var.tags
}

resource "aws_vpc_endpoint" "interface" {
  for_each            = local.interface_services
  vpc_id              = aws_vpc.this.id
  service_name        = "com.amazonaws.eu-west-2.${each.key}"
  vpc_endpoint_type   = "Interface"
  private_dns_enabled = true
  subnet_ids          = [for az in slice(var.availability_zones, 0, var.endpoint_az_count) : aws_subnet.tasks[az].id]
  security_group_ids  = [aws_security_group.endpoints.id]
  # Task IAM is the access boundary. The endpoint alone grants no IAM permissions.
  tags = merge(var.tags, { Name = "${var.name}-${replace(each.key, ".", "-")}" })
}

resource "aws_vpc_endpoint" "s3" {
  vpc_id            = aws_vpc.this.id
  service_name      = "com.amazonaws.eu-west-2.s3"
  vpc_endpoint_type = "Gateway"
  route_table_ids   = [for az in var.availability_zones : aws_route_table.tasks[az].id]
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid       = "GodiffyImages"
        Effect    = "Allow"
        Principal = "*"
        Action    = ["s3:GetObject", "s3:GetObjectVersion", "s3:PutObject", "s3:DeleteObjectVersion"]
        Resource  = ["${var.image_bucket_arn}/pending/*", "${var.image_bucket_arn}/images/*"]
      },
      {
        Sid       = "AWSManagedECRImageLayers"
        Effect    = "Allow"
        Principal = "*"
        Action    = ["s3:GetObject"]
        # ECR uses this AWS-owned regional S3 bucket; it is not application infrastructure.
        Resource = ["arn:aws:s3:::prod-eu-west-2-starport-layer-bucket/*"]
      },
    ]
  })
  tags = merge(var.tags, { Name = "${var.name}-s3" })
}

resource "aws_vpc_security_group_egress_rule" "tasks_s3" {
  security_group_id = aws_security_group.tasks.id
  prefix_list_id    = aws_vpc_endpoint.s3.prefix_list_id
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
  tags              = var.tags
}
