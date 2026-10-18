variable "instance_name" {
  description = "Name tag of the VM (e.g. greenpulse-app)."
  type        = string
}

variable "ami_id" {
  description = "AMI (OS image) of the VM."
  type        = string
}

variable "instance_type" {
  description = "EC2 instance type, which sets vCPU and RAM (t3.micro = 1 GiB)."
  type        = string
}

variable "disk_size_gb" {
  description = "Size of the root disk in GB."
  type        = number
}

variable "subnet_id" {
  description = "Subnet where the VM is launched."
  type        = string
}

variable "private_ip" {
  description = "Fixed private IP of the VM inside the subnet."
  type        = string
}

variable "security_group_ids" {
  description = "Security groups attached to the VM."
  type        = list(string)
}

variable "key_name" {
  description = "Name of the AWS key pair used for SSH."
  type        = string
}
