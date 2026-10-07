output "origin" { value = local.origin }
output "alb_dns_name" { value = aws_lb.this.dns_name }
output "alb_zone_id" { value = aws_lb.this.zone_id }
output "alb_arn_suffix" { value = aws_lb.this.arn_suffix }
output "target_group_arn_suffix" { value = aws_lb_target_group.this.arn_suffix }
output "repository_url" { value = aws_ecr_repository.this.repository_url }
output "cluster_name" { value = aws_ecs_cluster.this.name }
output "service_name" { value = var.release.service_enabled ? aws_ecs_service.this[0].name : null }
output "job_task_definitions" { value = { for key, job in local.job_definitions : job.kind => aws_ecs_task_definition.job[key].arn if split("/", key)[0] == var.release.image_digest } }
output "retained_image_digests" { value = local.release_digests }
output "log_group_name" { value = aws_cloudwatch_log_group.application.name }
