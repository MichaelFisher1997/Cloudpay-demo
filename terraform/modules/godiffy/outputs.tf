output "deployment" {
  description = "Non-secret integration identifiers; secret values never pass through Terraform."
  value = {
    environment          = var.environment
    account_id           = local.account_id
    region               = local.region
    application_origin   = module.application.origin
    alb_dns_name         = module.application.alb_dns_name
    alb_zone_id          = module.application.alb_zone_id
    image_bucket_name    = module.storage.image_bucket_name
    repository_url       = module.application.repository_url
    database_host        = module.database.host
    database_identifier  = module.database.identifier
    runtime_secret_arn   = module.database.runtime_secret_arn
    migration_secret_arn = module.database.migration_secret_arn
    cluster_name         = module.application.cluster_name
    service_name         = module.application.service_name
    job_task_definitions = module.application.job_task_definitions
    task_subnet_ids      = slice(module.networking.task_subnet_ids, 0, local.production ? 2 : 1)
    task_security_group  = module.networking.security_group_ids.tasks
    log_group_name       = module.application.log_group_name
    alarm_topic_arn      = aws_sns_topic.alarms.arn
    alarm_email_supplied = var.alarm_email != null
    service_enabled      = var.release.service_enabled
  }
}
