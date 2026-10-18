
# General
variable "aws_region" {
  description = "AWS region where everything is deployed."
  type        = string
  default     = "eu-west-3" # Paris
}

variable "aws_profile" {
  description = "AWS CLI profile used for credentials (see ~/.aws/credentials)."
  type        = string
  default     = "greenpulse"
}

variable "project_name" {
  description = "Prefix used to name every resource (e.g. greenpulse-app)."
  type        = string
  default     = "greenpulse"
}


# Network 
variable "vpc_cidr" {
  description = "IP range of the VPC."
  type        = string
  default     = "10.0.0.0/16"
}

variable "public_subnet_cidr" {
  description = "IP range of the public subnet (must be inside vpc_cidr)."
  type        = string
  default     = "10.0.1.0/24"
}

variable "availability_zone" {
  description = "Availability zone of the subnet."
  type        = string
  default     = "eu-west-3a"
}

variable "allowed_ssh_cidr" {
  description = "Only this CIDR may SSH into the VMs. Use your public IP with /32 (curl -s https://checkip.amazonaws.com)."
  type        = string

  validation {
    condition     = can(cidrhost(var.allowed_ssh_cidr, 0))
    error_message = "allowed_ssh_cidr must be a valid CIDR, e.g. 203.0.113.7/32."
  }
}

variable "app_port" {
  description = "Port exposed by the application (query-api)."
  type        = number
  default     = 8080
}

variable "db_port" {
  description = "PostgreSQL port."
  type        = number
  default     = 5432
}
