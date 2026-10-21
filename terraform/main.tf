# Root module: wires the modules together and holds the resources they share
# Order of creation: network -> bdd -> app -> monitoring.
# Shared: Ubuntu image and SSH key

# Latest official Ubuntu image published
data "aws_ami" "ubuntu" {
  most_recent = true
  owners      = [var.ubuntu_ami_owner]

  filter {
    name   = "name"
    values = [var.ubuntu_ami_name_filter]
  }

  filter {
    name   = "virtualization-type"
    values = ["hvm"]
  }
}

# Uploads YOUR existing public key to AWS. The private key never leaves your
# laptop and is never stored in the Terraform state.
resource "aws_key_pair" "admin" {
  key_name   = "${var.project_name}-key"
  public_key = file(pathexpand(var.ssh_public_key_path))
}


# Modules
module "network" {
  source = "./modules/network"

  project_name       = var.project_name
  vpc_cidr           = var.vpc_cidr
  public_subnet_cidr = var.public_subnet_cidr
  availability_zone  = var.availability_zone
  allowed_ssh_cidr   = var.allowed_ssh_cidr
  app_port           = var.app_port
  db_port            = var.db_port

  enable_monitoring   = var.enable_monitoring
  monitoring_ui_ports = var.monitoring_ui_ports
  app_metrics_ports   = var.app_metrics_ports
  bdd_metrics_ports   = var.bdd_metrics_ports
}

module "bdd" {
  source = "./modules/bdd"

  instance_name      = "${var.project_name}-bdd"
  ami_id             = data.aws_ami.ubuntu.id
  instance_type      = var.bdd_instance_type
  disk_size_gb       = var.bdd_disk_size_gb
  subnet_id          = module.network.public_subnet_id
  private_ip         = var.bdd_private_ip
  security_group_ids = [module.network.bdd_security_group_id]
  key_name           = aws_key_pair.admin.key_name
}

module "app" {
  source = "./modules/app"

  instance_name      = "${var.project_name}-app"
  ami_id             = data.aws_ami.ubuntu.id
  instance_type      = var.app_instance_type
  disk_size_gb       = var.app_disk_size_gb
  subnet_id          = module.network.public_subnet_id
  private_ip         = var.app_private_ip
  security_group_ids = [module.network.app_security_group_id]
  key_name           = aws_key_pair.admin.key_name

  depends_on = [module.bdd]
}

# Optional: count = 0 means the module creates nothing (and costs nothing).
module "monitoring" {
  source = "./modules/monitoring"
  count  = var.enable_monitoring ? 1 : 0

  instance_name      = "${var.project_name}-monitoring"
  ami_id             = data.aws_ami.ubuntu.id
  instance_type      = var.monitoring_instance_type
  disk_size_gb       = var.monitoring_disk_size_gb
  subnet_id          = module.network.public_subnet_id
  private_ip         = var.monitoring_private_ip
  security_group_ids = [module.network.monitoring_security_group_id]
  key_name           = aws_key_pair.admin.key_name
}
