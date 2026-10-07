output "image_bucket_name" {
  value = aws_s3_bucket.images.id
}
output "image_bucket_arn" {
  value = aws_s3_bucket.images.arn
}
output "alb_log_bucket" {
  # Policy dependency ensures ALB delivery access exists before logs are enabled.
  value      = var.enable_alb_logs ? aws_s3_bucket.alb_logs[0].id : null
  depends_on = [aws_s3_bucket_policy.alb_logs]
}
