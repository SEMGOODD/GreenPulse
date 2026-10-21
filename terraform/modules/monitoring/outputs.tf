output "instance_id" {
  description = "ID of the MONITORING instance."
  value       = aws_instance.monitoring.id
}

output "public_ip" {
  description = "Public IP, used by Ansible (SSH) and by your browser (Grafana)."
  value       = aws_instance.monitoring.public_ip
}

output "private_ip" {
  description = "Private IP, the source address of Prometheus' scrapes."
  value       = aws_instance.monitoring.private_ip
}
