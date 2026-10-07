resource "aws_sns_topic" "alarms" {
  name = "${local.name}-alarms"
  tags = local.tags
}

resource "aws_sns_topic_policy" "alarms" {
  arn = aws_sns_topic.alarms.arn
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid       = "OnlyGodiffyCloudWatchAlarms"
        Effect    = "Allow"
        Principal = { Service = "cloudwatch.amazonaws.com" }
        Action    = "sns:Publish"
        Resource  = aws_sns_topic.alarms.arn
        Condition = {
          StringEquals = { "aws:SourceAccount" = local.account_id }
          ArnLike      = { "aws:SourceArn" = "arn:aws:cloudwatch:${local.region}:${local.account_id}:alarm:${local.name}-*" }
        }
      },
      {
        Sid       = "DenyInsecureTransport"
        Effect    = "Deny"
        Principal = "*"
        # SNS topic policies accept only topic-level actions, not all SNS APIs.
        Action = [
          "sns:Publish", "sns:Subscribe", "sns:GetTopicAttributes", "sns:SetTopicAttributes",
          "sns:AddPermission", "sns:RemovePermission", "sns:DeleteTopic", "sns:ListSubscriptionsByTopic",
        ]
        Resource  = aws_sns_topic.alarms.arn
        Condition = { Bool = { "aws:SecureTransport" = "false", "aws:PrincipalIsAWSService" = "false" } }
      },
    ]
  })
}

resource "aws_sns_topic_subscription" "email" {
  count     = var.alarm_email == null ? 0 : 1
  topic_arn = aws_sns_topic.alarms.arn
  protocol  = "email"
  endpoint  = var.alarm_email
}

locals {
  alarms = {
    "alb-target-errors" = {
      namespace  = "AWS/ApplicationELB", metric = "HTTPCode_Target_5XX_Count", statistic = "Sum",
      threshold  = 5, comparison = "GreaterThanThreshold",
      dimensions = { LoadBalancer = module.application.alb_arn_suffix, TargetGroup = module.application.target_group_arn_suffix }
    }
    "alb-errors" = {
      namespace  = "AWS/ApplicationELB", metric = "HTTPCode_ELB_5XX_Count", statistic = "Sum",
      threshold  = 5, comparison = "GreaterThanThreshold",
      dimensions = { LoadBalancer = module.application.alb_arn_suffix }
    }
    "alb-unhealthy-targets" = {
      namespace  = "AWS/ApplicationELB", metric = "UnHealthyHostCount", statistic = "Maximum",
      threshold  = 0, comparison = "GreaterThanThreshold",
      dimensions = { LoadBalancer = module.application.alb_arn_suffix, TargetGroup = module.application.target_group_arn_suffix }
    }
    "database-cpu" = {
      namespace  = "AWS/RDS", metric = "CPUUtilization", statistic = "Average",
      threshold  = 80, comparison = "GreaterThanThreshold",
      dimensions = { DBInstanceIdentifier = module.database.identifier }
    }
    "database-storage" = {
      namespace  = "AWS/RDS", metric = "FreeStorageSpace", statistic = "Minimum",
      threshold  = 5368709120, comparison = "LessThanThreshold",
      dimensions = { DBInstanceIdentifier = module.database.identifier }
    }
    "database-connections" = {
      namespace  = "AWS/RDS", metric = "DatabaseConnections", statistic = "Maximum",
      threshold  = local.production ? 80 : 40, comparison = "GreaterThanThreshold",
      dimensions = { DBInstanceIdentifier = module.database.identifier }
    }
  }
  service_alarms = var.release.service_enabled ? {
    "service-memory" = {
      namespace  = "AWS/ECS", metric = "MemoryUtilization", statistic = "Average",
      threshold  = 80, comparison = "GreaterThanThreshold",
      dimensions = { ClusterName = module.application.cluster_name, ServiceName = module.application.service_name }
    }
    "service-cpu" = {
      namespace  = "AWS/ECS", metric = "CPUUtilization", statistic = "Average",
      threshold  = 85, comparison = "GreaterThanThreshold",
      dimensions = { ClusterName = module.application.cluster_name, ServiceName = module.application.service_name }
    }
    "service-healthy-targets" = {
      namespace  = "AWS/ApplicationELB", metric = "HealthyHostCount", statistic = "Minimum",
      threshold  = local.production ? 2 : 1, comparison = "LessThanThreshold",
      dimensions = { LoadBalancer = module.application.alb_arn_suffix, TargetGroup = module.application.target_group_arn_suffix }
    }
  } : {}
}

resource "aws_cloudwatch_metric_alarm" "this" {
  for_each            = merge(local.alarms, local.service_alarms)
  alarm_name          = "${local.name}-${each.key}"
  alarm_description   = "Godiffy ${var.environment}: ${each.value.metric}; see docs/operations.md"
  namespace           = each.value.namespace
  metric_name         = each.value.metric
  statistic           = each.value.statistic
  comparison_operator = each.value.comparison
  threshold           = each.value.threshold
  period              = 60
  evaluation_periods  = 3
  datapoints_to_alarm = 3
  treat_missing_data  = each.key == "service-healthy-targets" ? "breaching" : "notBreaching"
  dimensions          = each.value.dimensions
  alarm_actions       = [aws_sns_topic.alarms.arn]
  ok_actions          = [aws_sns_topic.alarms.arn]
  tags                = local.tags
}
