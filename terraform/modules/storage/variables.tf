variable "name" {
  type = string
}
variable "account_id" {
  type = string
}
variable "origin" {
  type        = string
  description = "One exact browser origin; never a wildcard and never tied to a VPC endpoint."
}
variable "enable_alb_logs" {
  type = bool
}
variable "tags" {
  type = map(string)
}
