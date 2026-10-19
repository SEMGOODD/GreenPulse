output "state_bucket" {
  description = "Name of the S3 bucket that stores the Terraform state."
  value       = aws_s3_bucket.tfstate.id
}

output "next_step" {
  description = "Command to run in terraform/ to use this bucket."
  value       = "cd .. && terraform init -backend-config=backend.hcl"
}
