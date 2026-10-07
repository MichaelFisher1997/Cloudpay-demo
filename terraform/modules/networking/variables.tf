variable "name" {
  type        = string
  description = "Dedicated Godiffy environment prefix."
  validation {
    condition     = contains(["godiffy-dev", "godiffy-prod"], var.name)
    error_message = "Only dedicated Godiffy dev/prod names are supported."
  }
}

variable "vpc_cidr" {
  type        = string
  description = "Dedicated /16 address range; never attach to another project's VPC."
  validation {
    condition     = can(cidrnetmask(var.vpc_cidr)) && can(regex("/16$", var.vpc_cidr))
    error_message = "Supply a valid IPv4 /16 VPC CIDR."
  }
}

variable "availability_zones" {
  type        = list(string)
  description = "Two distinct London availability zones."
  validation {
    condition = (
      length(var.availability_zones) == 2 &&
      length(distinct(var.availability_zones)) == 2 &&
      alltrue([for az in var.availability_zones : can(regex("^eu-west-2[a-c]$", az))])
    )
    error_message = "Provide two distinct eu-west-2 availability zones."
  }
}

variable "endpoint_az_count" {
  type        = number
  description = "One endpoint AZ is a deliberate dev compromise; production needs both."
  validation {
    condition     = contains([1, 2], var.endpoint_az_count)
    error_message = "Endpoint placement must use one or two AZs."
  }
}

variable "enable_http" {
  type        = bool
  description = "Dev bootstrap HTTP or an approved HTTPS redirect; never production plaintext forwarding."
}

variable "image_bucket_arn" {
  type        = string
  description = "Dedicated image bucket ARN for the S3 gateway endpoint policy."
}

variable "tags" {
  type        = map(string)
  description = "Common Godiffy tags."
}
