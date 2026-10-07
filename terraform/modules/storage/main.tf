locals {
  image_bucket_name = "${var.name}-images-${var.account_id}-eu-west-2"
}

resource "aws_s3_bucket" "images" {
  bucket        = local.image_bucket_name
  force_destroy = false
  tags          = merge(var.tags, { Name = local.image_bucket_name })
  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_s3_bucket_public_access_block" "images" {
  bucket                  = aws_s3_bucket.images.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "images" {
  bucket = aws_s3_bucket.images.id
  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "images" {
  bucket = aws_s3_bucket.images.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
    blocked_encryption_types = ["SSE-C"]
  }
}

resource "aws_s3_bucket_versioning" "images" {
  bucket = aws_s3_bucket.images.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_cors_configuration" "images" {
  bucket = aws_s3_bucket.images.id
  cors_rule {
    allowed_origins = [var.origin]
    allowed_methods = ["POST", "GET", "HEAD"]
    allowed_headers = ["content-type", "x-amz-*"]
    expose_headers  = ["ETag", "x-amz-version-id", "x-amz-checksum-sha256"]
    max_age_seconds = 300
  }
}

resource "aws_s3_bucket_policy" "images" {
  bucket = aws_s3_bucket.images.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "DenyInsecureTransport"
      Effect    = "Deny"
      Principal = "*"
      Action    = "s3:*"
      Resource  = [aws_s3_bucket.images.arn, "${aws_s3_bucket.images.arn}/*"]
      Condition = {
        Bool = {
          "aws:SecureTransport"       = "false"
          "aws:PrincipalIsAWSService" = "false"
        }
      }
    }]
  })
  # Do not deny requests outside the VPC endpoint: browsers need presigned HTTPS access.
  depends_on = [aws_s3_bucket_public_access_block.images]
}

resource "aws_s3_bucket_lifecycle_configuration" "images" {
  bucket = aws_s3_bucket.images.id
  rule {
    id     = "expire-staged-uploads"
    status = "Enabled"
    filter {
      prefix = "pending/"
    }
    expiration {
      days = 1
    }
    noncurrent_version_expiration {
      noncurrent_days = 1
    }
    abort_incomplete_multipart_upload {
      days_after_initiation = 1
    }
  }
  rule {
    id     = "remove-staging-delete-markers"
    status = "Enabled"
    filter {
      prefix = "pending/"
    }
    expiration {
      expired_object_delete_marker = true
    }
  }
  # Never expire images/ versions blindly: the application pins an exact version.
  depends_on = [aws_s3_bucket_versioning.images]
}

resource "aws_s3_bucket" "alb_logs" {
  count         = var.enable_alb_logs ? 1 : 0
  bucket        = "${var.name}-alb-logs-${var.account_id}-eu-west-2"
  force_destroy = false
  tags          = merge(var.tags, { Name = "${var.name}-alb-logs" })
  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_s3_bucket_public_access_block" "alb_logs" {
  count                   = var.enable_alb_logs ? 1 : 0
  bucket                  = aws_s3_bucket.alb_logs[0].id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "alb_logs" {
  count  = var.enable_alb_logs ? 1 : 0
  bucket = aws_s3_bucket.alb_logs[0].id
  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "alb_logs" {
  count  = var.enable_alb_logs ? 1 : 0
  bucket = aws_s3_bucket.alb_logs[0].id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "alb_logs" {
  count  = var.enable_alb_logs ? 1 : 0
  bucket = aws_s3_bucket.alb_logs[0].id
  rule {
    id     = "retain-logs-90-days"
    status = "Enabled"
    filter {}
    expiration {
      days = 90
    }
  }
}

resource "aws_s3_bucket_policy" "alb_logs" {
  count  = var.enable_alb_logs ? 1 : 0
  bucket = aws_s3_bucket.alb_logs[0].id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid       = "ALBLogDelivery"
        Effect    = "Allow"
        Principal = { Service = "logdelivery.elasticloadbalancing.amazonaws.com" }
        Action    = "s3:PutObject"
        Resource  = "${aws_s3_bucket.alb_logs[0].arn}/${var.name}/AWSLogs/${var.account_id}/*"
        Condition = { ArnLike = { "aws:SourceArn" = "arn:aws:elasticloadbalancing:eu-west-2:${var.account_id}:loadbalancer/*" } }
      },
      {
        Sid       = "DenyInsecureTransport"
        Effect    = "Deny"
        Principal = "*"
        Action    = "s3:*"
        Resource  = [aws_s3_bucket.alb_logs[0].arn, "${aws_s3_bucket.alb_logs[0].arn}/*"]
        Condition = { Bool = { "aws:SecureTransport" = "false", "aws:PrincipalIsAWSService" = "false" } }
      },
    ]
  })
  depends_on = [aws_s3_bucket_public_access_block.alb_logs]
}
