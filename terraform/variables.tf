
# General
variable "aws_region" {
  description = "AWS region where everything is deployed."
  type        = string
  default     = "eu-north-1" # Stockholm: the only region allowed by the project SCP (RegionFloor)
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
  default     = "eu-north-1a"
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

# OS image and SSH
variable "ubuntu_ami_owner" {
  description = "AWS account that publishes the official Ubuntu images (Canonical)."
  type        = string
  default     = "099720109477"
}

variable "ubuntu_ami_name_filter" {
  description = "Name pattern of the Ubuntu image (24.04 LTS Noble, x86_64)."
  type        = string
  default     = "ubuntu/images/hvm-ssd-gp3/ubuntu-noble-24.04-amd64-server-*"
}

variable "ssh_user" {
  description = "Default SSH user of the Ubuntu images."
  type        = string
  default     = "ubuntu"
}

variable "ssh_public_key_path" {
  description = "Public key uploaded to AWS for SSH access."
  type        = string
  default     = "~/.ssh/id_ed25519.pub"
}

variable "ssh_private_key_path" {
  description = "Matching private key, used by Ansible to connect (never uploaded)."
  type        = string
  default     = "~/.ssh/id_ed25519"
}

# BDD VM (2048 MB RAM, 20 GB disk, Ubuntu, IP2)
variable "bdd_instance_type" {
  description = "Instance type of the BDD VM (t3.small = 2 GiB RAM)."
  type        = string
  default     = "t3.small"
}

variable "bdd_disk_size_gb" {
  description = "Root disk size of the BDD VM in GB."
  type        = number
  default     = 20
}

variable "bdd_private_ip" {
  description = "Fixed private IP of the BDD VM (IP2). Must be inside public_subnet_cidr."
  type        = string
  default     = "10.0.1.20"
}

# APP VM (1024 MB RAM, 20 GB disk, Ubuntu, IP1)
variable "app_instance_type" {
  description = "Instance type of the APP VM (t3.micro = 1 GiB RAM)."
  type        = string
  default     = "t3.micro"
}

variable "app_disk_size_gb" {
  description = "Root disk size of the APP VM in GB."
  type        = number
  default     = 20
}

variable "app_private_ip" {
  description = "Fixed private IP of the APP VM (IP1). Must be inside public_subnet_cidr."
  type        = string
  default     = "10.0.1.10"
}
