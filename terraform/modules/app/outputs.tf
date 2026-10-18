output "instance_id" {
  description = "ID of the APP instance."
  value       = aws_instance.app.id
}

output "public_ip" {
  description = "Public IP, used by Ansible (SSH) and by the browser (app port)."
  value       = aws_instance.app.public_ip
}

output "private_ip" {
  description = "Private IP, the only address allowed in PostgreSQL's pg_hba.conf."
  value       = aws_instance.app.private_ip
}
