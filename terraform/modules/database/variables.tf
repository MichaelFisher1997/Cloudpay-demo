variable "name" { type = string }
variable "subnet_ids" { type = list(string) }
variable "security_group_id" { type = string }
variable "production" { type = bool }
variable "tags" { type = map(string) }
variable "final_snapshot_suffix" {
  type        = string
  description = "Set a unique, reviewed suffix before any approved retirement; never silently skip the final snapshot."
  default     = "review-required"
  validation {
    condition     = can(regex("^[a-z0-9][a-z0-9-]{0,59}[a-z0-9]$", var.final_snapshot_suffix))
    error_message = "Snapshot suffix must contain 2-61 lowercase alphanumeric/hyphen characters with alphanumeric ends."
  }
}
