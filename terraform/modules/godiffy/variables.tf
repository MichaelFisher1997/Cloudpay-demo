variable "environment" {
  type        = string
  description = "Dedicated environment, with a separate root and state key."
  validation {
    condition     = contains(["dev", "prod"], var.environment)
    error_message = "Only dev and prod environments are supported."
  }
}

variable "release" {
  type = object({
    image_digest           = optional(string)
    retained_image_digests = optional(set(string), [])
    bootstrap_enabled      = optional(bool, false)
    bootstrap_retained     = optional(bool, false)
    service_enabled        = optional(bool, false)
    database_ready         = optional(bool, false)
  })
  default = {}
  validation {
    condition = (
      var.environment != "prod" || !var.release.service_enabled ||
      (var.production_reviewed && var.certificate_arn != null && var.alarm_email != null)
    )
    error_message = "Production service activation requires separate review, an approved TLS certificate, and an alarm recipient."
  }
}

variable "app_url" {

  type        = string
  description = "Approved HTTPS origin at the final integration stage; null uses dev ALB HTTP."
  default     = null
  nullable    = true
  validation {
    condition     = var.app_url == null || can(regex("^https://[a-z0-9][a-z0-9.-]*[a-z0-9]$", var.app_url))
    error_message = "Custom application URL must be a bare HTTPS origin without path, port, credentials, query or fragment."
  }
}

variable "task_permissions_boundaries" {
  type    = map(string)
  default = {}
}

variable "certificate_arn" {
  type        = string
  description = "Existing approved, issued London ACM certificate; DNS/certificate creation remains a later stage."
  default     = null
  nullable    = true
  validation {
    condition = (
      var.certificate_arn == null ||
      (can(regex("^arn:aws:acm:eu-west-2:218549829565:certificate/[a-f0-9-]+$", var.certificate_arn)) && var.app_url != null)
    )
    error_message = "TLS needs an ACM ARN in the fixed account/region and an explicit approved HTTPS origin."
  }
}

variable "alarm_email" {
  type        = string
  description = "Optional confirmed SNS recipient; alarms alone do not deliver notifications."
  default     = null
  nullable    = true
  validation {
    condition     = var.alarm_email == null || can(regex("^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$", var.alarm_email))
    error_message = "Provide an email address or null."
  }
}

variable "production_reviewed" {
  type        = bool
  description = "Additional production safety switch, NOT a substitute for plan/apply approval or CI environment protection."
  default     = false
}

variable "https_redirect_enabled" {
  type    = bool
  default = false
}
variable "invited_emails" {
  type    = list(string)
  default = []
}
variable "final_snapshot_suffix" {
  type    = string
  default = "review-required"
}
