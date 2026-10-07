variable "release" {
  description = "Default foundations only. Enable jobs/service incrementally with reviewed real image digest."
  type = object({
    image_digest      = optional(string)
    bootstrap_enabled = optional(bool, false)
    service_enabled   = optional(bool, false)
    database_ready    = optional(bool, false)
  })
  default = {}
}
variable "app_url" {
  type    = string
  default = null
}
variable "certificate_arn" {
  type    = string
  default = null
}
variable "alarm_email" {
  type    = string
  default = null
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
