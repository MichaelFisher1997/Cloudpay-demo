# Inputs supplied by modules/godiffy/main.tf; this module creates application
# resources using existing networking/database identifiers, not duplicate ones.
variable "name" { type = string }
variable "account_id" { type = string }
variable "production" { type = bool }
variable "tags" { type = map(string) }
variable "task_permissions_boundaries" {
  type    = map(string)
  default = {}
}
# Object groups the subnet and security-group identifiers used by ALB and ECS.
variable "network" {
  type = object({
    vpc_id            = string
    public_subnet_ids = list(string)
    task_subnet_ids   = list(string)
    alb_sg_id         = string
    task_sg_id        = string
  })
}
# Secret ARNs are identifiers, never secret values or database passwords.
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
# Optional HTTPS integration; null keeps the default DEV ALB HTTP origin.
variable "app_url" {
  type     = string
  default  = null
  nullable = true
  validation {
    condition     = var.app_url == null || can(regex("^https://[a-z0-9][a-z0-9.-]*[a-z0-9]$", var.app_url))
    error_message = "An explicit application URL must be a bare HTTPS origin; only the default DEV ALB origin may use HTTP."
  }
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
  description = "Legacy DEV password-auth setting retained for compatibility; current Clerk access uses release.clerk_auth.allowed_emails."
  default     = []
  validation {
    condition = (
      (!var.production || length(var.invited_emails) == 0) &&
      alltrue([for email in var.invited_emails : can(regex("^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$", email))])
    )
    error_message = "Use valid dev test addresses only; production registration awaits a verified invitation design."
  }
}
# Current image/auth settings plus retained task history. optional(type, default)
# allows omitted fields; validation rejects unsafe combinations before deployment.
variable "release" {
  type = object({
    image_digest                     = optional(string)
    retained_image_digests           = optional(set(string), [])
    retained_bootstrap_image_digests = optional(set(string), [])
    retained_web_containers          = optional(map(string), {})
    clerk_auth = optional(object({
      publishable_key = string
      issuer          = string
      jwt_key         = string
      allowed_emails  = list(string)
    }))
    bootstrap_enabled  = optional(bool, false)
    bootstrap_retained = optional(bool, false)
    service_enabled    = optional(bool, false)
    database_ready     = optional(bool, false)
  })
  default = {}
  # Check public Clerk configuration and named emails, not live login success.
  validation {
    condition = var.release.clerk_auth == null ? true : (
      startswith(var.release.clerk_auth.publishable_key, var.production ? "pk_live_" : "pk_test_") &&
      startswith(var.release.clerk_auth.jwt_key, "-----BEGIN PUBLIC KEY-----") &&
      (var.production ? (
        can(regex("^https://[a-z0-9][a-z0-9.-]*[a-z0-9]$", var.release.clerk_auth.issuer)) &&
        !endswith(var.release.clerk_auth.issuer, ".clerk.accounts.dev")
      ) : can(regex("^https://[a-z0-9-]+\\.clerk\\.accounts\\.dev$", var.release.clerk_auth.issuer))) &&
      try(base64decode(trimprefix(var.release.clerk_auth.publishable_key, var.production ? "pk_live_" : "pk_test_")), "") == "${trimprefix(var.release.clerk_auth.issuer, "https://")}$" &&
      length(var.release.clerk_auth.allowed_emails) > 0 &&
      alltrue([for email in var.release.clerk_auth.allowed_emails : can(regex("^[^@\\s*]+@[^@\\s*]+\\.[^@\\s*]+$", email))])
    )
    error_message = "Clerk requires environment-matched publishable/public keys, a matching HTTPS issuer and named emails; production cannot use a development instance."
  }
  validation {
    condition = !var.production || !var.release.service_enabled || (
      var.release.clerk_auth != null && var.app_url != null
    )
    error_message = "Production service activation requires explicit Clerk live configuration and an HTTPS application origin."
  }
  # Require digest-pinned images instead of mutable tags such as "latest".
  validation {
    condition = (
      var.release.image_digest == null ||
      can(regex("^sha256:[a-f0-9]{64}$", var.release.image_digest))
    )
    error_message = "Use an immutable SHA-256 digest from the dedicated Godiffy ECR repository."
  }
  validation {
    condition     = alltrue([for digest in var.release.retained_image_digests : can(regex("^sha256:[a-f0-9]{64}$", digest))])
    error_message = "Retained revisions require actual immutable image digests."
  }
  validation {
    condition = alltrue([for digest in var.release.retained_bootstrap_image_digests :
      can(regex("^sha256:[a-f0-9]{64}$", digest)) && (contains(var.release.retained_image_digests, digest) || digest == var.release.image_digest)
    ])
    error_message = "Retain only known immutable bootstrap definitions from the reviewed release history."
  }
  validation {
    condition = (
      (!var.release.service_enabled && !var.release.bootstrap_enabled) ||
      var.release.image_digest != null
    )
    error_message = "An actual image digest is required before enabling service or bootstrap jobs."
  }
  # database_ready is an operator acknowledgment, not an actual DB connectivity test.
  validation {
    condition     = !var.release.service_enabled || (var.release.database_ready && !var.release.bootstrap_enabled)
    error_message = "Service activation needs confirmed DB initialization/migrations and removal of standing bootstrap access."
  }
  validation {
    condition     = !var.release.service_enabled || var.app_url == null || var.certificate_arn != null
    error_message = "Do not activate a service with a custom HTTPS origin before its TLS listener is configured."
  }
}
