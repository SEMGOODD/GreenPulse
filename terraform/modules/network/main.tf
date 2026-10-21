# Network module: VPC, public subnet, internet access and security groups.
#
# Security groups live here (not in the app/bdd modules) on purpose:
# the DB security group must reference the app security group, and the
# bdd module is created BEFORE the app module. If the app SG lived in the
# app module, bdd would depend on app and app on bdd -> dependency cycle.

# 
# VPC and subnet
# 
resource "aws_vpc" "main" {
  cidr_block           = var.vpc_cidr
  enable_dns_support   = true
  enable_dns_hostnames = true

  tags = {
    Name = "${var.project_name}-vpc"
  }
}

resource "aws_subnet" "public" {
  vpc_id            = aws_vpc.main.id
  cidr_block        = var.public_subnet_cidr
  availability_zone = var.availability_zone

  # Every VM launched here gets a public IP (needed for SSH and apt without a NAT gateway).
  map_public_ip_on_launch = true

  tags = {
    Name = "${var.project_name}-public-subnet"
  }
}

# 
# Internet access: gateway + route table
# 
resource "aws_internet_gateway" "main" {
  vpc_id = aws_vpc.main.id

  tags = {
    Name = "${var.project_name}-igw"
  }
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.main.id

  # Everything that is not inside the VPC goes out through the internet gateway.
  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.main.id
  }

  tags = {
    Name = "${var.project_name}-public-rt"
  }
}

resource "aws_route_table_association" "public" {
  subnet_id      = aws_subnet.public.id
  route_table_id = aws_route_table.public.id
}

# 
# Security group: APP VM
# 
resource "aws_security_group" "app" {
  name        = "${var.project_name}-app-sg"
  description = "APP VM: SSH from admin IP, application port from anywhere"
  vpc_id      = aws_vpc.main.id

  tags = {
    Name = "${var.project_name}-app-sg"
  }
}

resource "aws_vpc_security_group_ingress_rule" "app_ssh" {
  security_group_id = aws_security_group.app.id
  description       = "SSH from admin IP only"
  cidr_ipv4         = var.allowed_ssh_cidr
  ip_protocol       = "tcp"
  from_port         = 22
  to_port           = 22
}

resource "aws_vpc_security_group_ingress_rule" "app_http" {
  security_group_id = aws_security_group.app.id
  description       = "Application port, public"
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "tcp"
  from_port         = var.app_port
  to_port           = var.app_port
}

resource "aws_vpc_security_group_egress_rule" "app_all" {
  security_group_id = aws_security_group.app.id
  description       = "All outbound traffic (apt, pip, docker pulls, DB)"
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "-1"
}

# 
# Security group: BDD VM
# 
resource "aws_security_group" "bdd" {
  name        = "${var.project_name}-bdd-sg"
  description = "BDD VM: SSH from admin IP, PostgreSQL from APP SG only"
  vpc_id      = aws_vpc.main.id

  tags = {
    Name = "${var.project_name}-bdd-sg"
  }
}

resource "aws_vpc_security_group_ingress_rule" "bdd_ssh" {
  security_group_id = aws_security_group.bdd.id
  description       = "SSH from admin IP only"
  cidr_ipv4         = var.allowed_ssh_cidr
  ip_protocol       = "tcp"
  from_port         = 22
  to_port           = 22
}

resource "aws_vpc_security_group_ingress_rule" "bdd_postgres_from_app" {
  security_group_id            = aws_security_group.bdd.id
  description                  = "PostgreSQL from the APP security group only"
  referenced_security_group_id = aws_security_group.app.id
  ip_protocol                  = "tcp"
  from_port                    = var.db_port
  to_port                      = var.db_port
}

resource "aws_vpc_security_group_egress_rule" "bdd_all" {
  security_group_id = aws_security_group.bdd.id
  description       = "All outbound traffic (apt updates)"
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "-1"
}


# Security group: MONITORING VM (only when enable_monitoring = true)

# count = 0 or 1 turns the resource off or on; for_each over an empty map
# creates no rule at all.
resource "aws_security_group" "monitoring" {
  count = var.enable_monitoring ? 1 : 0

  name        = "${var.project_name}-monitoring-sg"
  description = "MONITORING VM: SSH and web UIs from admin IP only"
  vpc_id      = aws_vpc.main.id

  tags = {
    Name = "${var.project_name}-monitoring-sg"
  }
}

resource "aws_vpc_security_group_ingress_rule" "monitoring_ssh" {
  count = var.enable_monitoring ? 1 : 0

  security_group_id = aws_security_group.monitoring[0].id
  description       = "SSH from admin IP only"
  cidr_ipv4         = var.allowed_ssh_cidr
  ip_protocol       = "tcp"
  from_port         = 22
  to_port           = 22
}

# Grafana, Prometheus and Alertmanager UIs: your browser only, never public.
resource "aws_vpc_security_group_ingress_rule" "monitoring_ui" {
  for_each = var.enable_monitoring ? var.monitoring_ui_ports : {}

  security_group_id = aws_security_group.monitoring[0].id
  description       = "${each.key} UI from admin IP only"
  cidr_ipv4         = var.allowed_ssh_cidr
  ip_protocol       = "tcp"
  from_port         = each.value
  to_port           = each.value
}

resource "aws_vpc_security_group_egress_rule" "monitoring_all" {
  count = var.enable_monitoring ? 1 : 0

  security_group_id = aws_security_group.monitoring[0].id
  description       = "All outbound traffic (scrapes, apt, docker pulls, Discord webhook)"
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "-1"
}

# Metrics ports open to the monitoring security group ONLY: nobody else,
# not even your IP, can read them.
resource "aws_vpc_security_group_ingress_rule" "app_metrics_from_monitoring" {
  for_each = var.enable_monitoring ? var.app_metrics_ports : {}

  security_group_id            = aws_security_group.app.id
  description                  = "${each.key} metrics, scraped by Prometheus"
  referenced_security_group_id = aws_security_group.monitoring[0].id
  ip_protocol                  = "tcp"
  from_port                    = each.value
  to_port                      = each.value
}

resource "aws_vpc_security_group_ingress_rule" "bdd_metrics_from_monitoring" {
  for_each = var.enable_monitoring ? var.bdd_metrics_ports : {}

  security_group_id            = aws_security_group.bdd.id
  description                  = "${each.key} metrics, scraped by Prometheus"
  referenced_security_group_id = aws_security_group.monitoring[0].id
  ip_protocol                  = "tcp"
  from_port                    = each.value
  to_port                      = each.value
}
