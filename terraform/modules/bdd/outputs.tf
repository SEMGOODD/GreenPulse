output "instance_id" {
  description = "ID of the BDD instance."
  value       = aws_instance.bdd.id
}

output "public_ip" {
  description = "Public IP, used by Ansible to SSH into the VM."
  value       = aws_instance.bdd.public_ip
}

output "private_ip" {
  description = "Private IP, used by the app to reach PostgreSQL inside the VPC."
  value       = aws_instance.bdd.private_ip
}
