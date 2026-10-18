output "vpc_id" {
  description = "ID of the VPC."
  value       = aws_vpc.main.id
}

output "public_subnet_id" {
  description = "ID of the public subnet, where the VMs are launched."
  value       = aws_subnet.public.id
}

output "app_security_group_id" {
  description = "Security group to attach to the APP VM."
  value       = aws_security_group.app.id
}

output "bdd_security_group_id" {
  description = "Security group to attach to the BDD VM."
  value       = aws_security_group.bdd.id
}
