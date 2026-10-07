variable "release" {
  description = "Default foundations only; production deployment is not authorised by this configuration."
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
variable "production_reviewed" {
  type    = bool
  default = false
}
variable "https_redirect_enabled" {
  type    = bool
  default = false
}
variable "final_snapshot_suffix" {
  type    = string
  default = "review-required"
}
