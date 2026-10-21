# Everything Ansible needs to connect to the VMs, printed after `terraform apply`
# and readable at any time with `terraform output`.

output "app_public_ip" {
  description = "Public IP of the APP VM (SSH and browser)."
  value       = module.app.public_ip
}

output "app_private_ip" {
  description = "Private IP of the APP VM (allowed in pg_hba.conf)."
  value       = module.app.private_ip
}

output "bdd_public_ip" {
  description = "Public IP of the BDD VM (SSH)."
  value       = module.bdd.public_ip
}

output "bdd_private_ip" {
  description = "Private IP of the BDD VM (used by the app to reach PostgreSQL)."
  value       = module.bdd.private_ip
}

output "ssh_user" {
  description = "SSH user for Ansible."
  value       = var.ssh_user
}

output "ssh_private_key_path" {
  description = "Private key for Ansible (ansible_ssh_private_key_file)."
  value       = var.ssh_private_key_path
}

output "ssh_commands" {
  description = "Ready-to-paste SSH commands."
  value = {
    app = "ssh -i ${var.ssh_private_key_path} ${var.ssh_user}@${module.app.public_ip}"
    bdd = "ssh -i ${var.ssh_private_key_path} ${var.ssh_user}@${module.bdd.public_ip}"
  }
}

output "app_url" {
  description = "URL of the application."
  value       = "http://${module.app.public_ip}:${var.app_port}"
}

output "ansible_inventory_path" {
  description = "Inventory generated for Ansible."
  value       = abspath(local_file.ansible_inventory.filename)
}

output "ansible_rerun_command" {
  description = "Command to re-run the configuration by hand, without Terraform."
  value       = "cd ${abspath(local.ansible_dir)} && ansible-playbook playbook.yml -e app_image_tag=sha-7f515a6"
}

# Monitoring outputs are null when enable_monitoring = false.
output "grafana_url" {
  description = "Grafana (login admin, password: ansible-vault view group_vars/all/vault.yml)."
  value       = var.enable_monitoring ? "http://${module.monitoring[0].public_ip}:${var.monitoring_ui_ports["grafana"]}" : null
}

output "prometheus_url" {
  description = "Prometheus UI (Status > Targets shows every scraped endpoint)."
  value       = var.enable_monitoring ? "http://${module.monitoring[0].public_ip}:${var.monitoring_ui_ports["prometheus"]}" : null
}
