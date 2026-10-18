# APP module: the EC2 instance that runs the application.
# The application is deployed later by Ansible (roles/app)

resource "aws_instance" "app" {
  ami           = var.ami_id
  instance_type = var.instance_type
  key_name      = var.key_name

  subnet_id              = var.subnet_id
  private_ip             = var.private_ip
  vpc_security_group_ids = var.security_group_ids

  root_block_device {
    volume_size           = var.disk_size_gb
    volume_type           = "gp3"
    encrypted             = true
    delete_on_termination = true
  }

  # Force IMDSv2 (token-based instance metadata), an AWS security best practice.
  metadata_options {
    http_tokens = "required"
  }

  tags = {
    Name = var.instance_name
    Role = "app"
  }

  # The AMI comes from a "most recent Ubuntu" lookup. Without this, a new
  # Ubuntu release would make Terraform destroy and recreate the VM.
  lifecycle {
    ignore_changes = [ami]
  }
}
