# Terraform generates the Ansible inventory, then runs
# ansible-playbook, so a single `terraform apply` builds AND configures everything.

locals {
  ansible_dir = "${path.module}/../ansible"

  # Fingerprint of the Ansible code (the generated inventory excluded)
  ansible_code_hash = sha1(join("", [
    for file in sort(fileset(local.ansible_dir, "**")) :
    filesha1("${local.ansible_dir}/${file}") if file != "inventory.ini"
  ]))
}

resource "local_file" "ansible_inventory" {
  filename        = "${local.ansible_dir}/inventory.ini"
  file_permission = "0644"
  content = templatefile("${path.module}/templates/inventory.ini.tftpl", {
    app_name             = "${var.project_name}-app"
    app_public_ip        = module.app.public_ip
    app_private_ip       = module.app.private_ip
    bdd_name             = "${var.project_name}-bdd"
    bdd_public_ip        = module.bdd.public_ip
    bdd_private_ip       = module.bdd.private_ip
    ssh_user             = var.ssh_user
    ssh_private_key_path = pathexpand(var.ssh_private_key_path)
  })
}

# terraform_data is built into Terraform (no extra provider, unlike null_resource).
# It is replaced, so the playbook runs again, whenever a trigger value changes.
resource "terraform_data" "ansible_playbook" {
  count = var.run_ansible ? 1 : 0

  triggers_replace = {
    app_instance = module.app.instance_id
    bdd_instance = module.bdd.instance_id
    inventory    = local_file.ansible_inventory.content
    ansible_code = local.ansible_code_hash
  }

  provisioner "local-exec" {
    # Run from ansible/ so that ansible.cfg (inventory, vault, SSH options) is used.
    working_dir = local.ansible_dir
    command     = "ansible-galaxy collection install -r requirements.yml && ansible-playbook playbook.yml"

    environment = {
      ANSIBLE_FORCE_COLOR = "1"
    }
  }
}
