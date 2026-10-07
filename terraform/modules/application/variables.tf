variable "name" { type = string }
variable "account_id" { type = string }
variable "production" { type = bool }
variable "tags" { type = map(string) }
variable "task_permissions_boundaries" {
  type    = map(string)
  default = {}
}
variable "network" {
  type = object({
    vpc_id            = string
    public_subnet_ids = list(string)
    task_subnet_ids   = list(string)
    alb_sg_id         = string
    task_sg_id        = string
  })
}
variable "database" {
  type = object({
    host                 = string
    runtime_secret_arn   = string
    migration_secret_arn = string
    master_secret_arn    = string
  })
}
variable "image_bucket_name" { type = string }
variable "image_bucket_arn" { type = string }
variable "alb_log_bucket" {
  type     = string
  default  = null
  nullable = true
}
variable "app_url" {
  type     = string
  default  = null
  nullable = true
}
variable "certificate_arn" {
  type     = string
  default  = null
  nullable = true
  validation {
    condition     = var.certificate_arn == null || var.app_url != null
    error_message = "A TLS listener requires an explicit custom HTTPS application origin."
  }
}
variable "https_redirect_enabled" {
  type    = bool
  default = false
  validation {
    condition     = !var.https_redirect_enabled || (var.certificate_arn != null && var.app_url != null)
    error_message = "Enable redirects only after certificate, custom-origin DNS and HTTPS verification."
  }
}
variable "invited_emails" {
  type        = list(string)
  description = "Dev-only test-account allowlist; visible in state/task config, not a verified invitation mechanism."
  default     = []
  validation {
    condition = (
      (!var.production || length(var.invited_emails) == 0) &&
      alltrue([for email in var.invited_emails : can(regex("^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$", email))])
    )
    error_message = "Use valid dev test addresses only; production registration awaits a verified invitation design."
  }
}
variable "release" {
  type = object({
    image_digest       = optional(string)
    bootstrap_enabled  = optional(bool, false)
    bootstrap_retained = optional(bool, false)
    service_enabled    = optional(bool, false)
    database_ready     = optional(bool, false)
  })
  default = {}
  validation {
    condition = (
      var.release.image_digest == null ||
      can(regex("^sha256:[a-f0-9]{64}$", var.release.image_digest))
    )
    error_message = "Use an immutable SHA-256 digest from the dedicated Godiffy ECR repository."
  }
  validation {
    condition = (
      (!var.release.service_enabled && !var.release.bootstrap_enabled) ||
      var.release.image_digest != null
    )
    error_message = "An actual image digest is required before enabling service or bootstrap jobs."
  }
  validation {
    condition     = !var.release.service_enabled || (var.release.database_ready && !var.release.bootstrap_enabled)
    error_message = "Service activation needs confirmed DB initialization/migrations and removal of standing bootstrap access."
  }
  validation {
    condition     = !var.release.service_enabled || var.app_url == null || var.certificate_arn != null
    error_message = "Do not activate a service with a custom HTTPS origin before its TLS listener is configured."
  }
}
