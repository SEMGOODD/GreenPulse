variable "project_name" {
  description = "Prefix used to name the resources."
  type        = string
}

variable "vpc_cidr" {
  description = "IP range of the VPC."
  type        = string
}

variable "public_subnet_cidr" {
  description = "IP range of the public subnet."
  type        = string
}

variable "availability_zone" {
  description = "Availability zone of the subnet."
  type        = string
}

variable "allowed_ssh_cidr" {
  description = "CIDR allowed to SSH into the VMs."
  type        = string
}

variable "app_port" {
  description = "Port exposed publicly by the application."
  type        = number
}

variable "db_port" {
  description = "PostgreSQL port, reachable only from the app security group."
  type        = number
}
