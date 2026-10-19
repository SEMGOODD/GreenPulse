variable "aws_region" {
  description = "AWS region of the state bucket (the project SCP only allows eu-north-1)."
  type        = string
  default     = "eu-north-1"
}

variable "aws_profile" {
  description = "AWS CLI profile used for credentials."
  type        = string
  default     = "greenpulse"
}

variable "project_name" {
  description = "Prefix of the bucket name."
  type        = string
  default     = "greenpulse"
}

variable "state_key" {
  description = "Path of the main state file inside the bucket."
  type        = string
  default     = "greenpulse/terraform.tfstate"
}

variable "force_destroy" {
  description = "Allow `terraform destroy` to delete the bucket even if it still contains state files."
  type        = bool
  default     = false
}
