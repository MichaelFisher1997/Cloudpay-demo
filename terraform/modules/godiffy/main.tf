locals {
  account_id = "218549829565"
  region     = "eu-west-2"
  name       = "godiffy-${var.environment}"
  production = var.environment == "prod" # for this demo should always be false
  tags = {
    Project     = "godiffy"
    Environment = var.environment
    ManagedBy   = "terraform"
    Purpose     = "cloudpay-technical-assessment"
  }
}

module "networking" {
  source             = "../networking"
  name               = local.name
  vpc_cidr           = local.production ? "10.43.0.0/16" : "10.42.0.0/16"
  availability_zones = ["eu-west-2a", "eu-west-2b"]
  endpoint_az_count  = local.production ? 2 : 1 # if prod use two endpoint othersie use one
  enable_http        = !local.production || var.certificate_arn != null
  image_bucket_arn   = "arn:aws:s3:::${local.name}-images-${local.account_id}-${local.region}"
  tags               = local.tags
}

module "storage" {
  source          = "../storage"
  name            = local.name
  account_id      = local.account_id
  origin          = module.application.origin
  enable_alb_logs = local.production
  tags            = local.tags
}

module "database" {
  source                = "../database"
  name                  = local.name
  production            = local.production
  subnet_ids            = module.networking.database_subnet_ids
  security_group_id     = module.networking.security_group_ids.database
  tags                  = local.tags
  final_snapshot_suffix = var.final_snapshot_suffix
}

module "application" {
  source                      = "../application"
  name                        = local.name
  account_id                  = local.account_id
  production                  = local.production
  release                     = var.release
  app_url                     = local.production ? coalesce(var.app_url, "https://godiffy.com") : var.app_url
  certificate_arn             = var.certificate_arn
  https_redirect_enabled      = var.https_redirect_enabled
  invited_emails              = var.invited_emails
  task_permissions_boundaries = var.task_permissions_boundaries
  network = {
    vpc_id            = module.networking.vpc_id
    public_subnet_ids = module.networking.public_subnet_ids
    # The single dev task shares the endpoint AZ: availability/cost compromise is explicit.
    task_subnet_ids = slice(module.networking.task_subnet_ids, 0, local.production ? 2 : 1)
    alb_sg_id       = module.networking.security_group_ids.alb
    task_sg_id      = module.networking.security_group_ids.tasks
  }
  database = {
    host                 = module.database.host
    runtime_secret_arn   = module.database.runtime_secret_arn
    migration_secret_arn = module.database.migration_secret_arn
    master_secret_arn    = module.database.master_secret_arn
  }
  image_bucket_name = module.storage.image_bucket_name
  image_bucket_arn  = module.storage.image_bucket_arn
  alb_log_bucket    = module.storage.alb_log_bucket
  tags              = local.tags
  # Complete routes/endpoints/SG rules before any task may be started.
  depends_on = [module.networking]
}
