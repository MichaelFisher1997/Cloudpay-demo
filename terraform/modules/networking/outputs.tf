output "vpc_id" {
  value = aws_vpc.this.id
}
output "public_subnet_ids" {
  value = [for az in var.availability_zones : aws_subnet.public[az].id]
}
output "task_subnet_ids" {
  value = [for az in var.availability_zones : aws_subnet.tasks[az].id]
}
output "database_subnet_ids" {
  value = [for az in var.availability_zones : aws_subnet.database[az].id]
}
output "security_group_ids" {
  value = {
    alb      = aws_security_group.alb.id
    tasks    = aws_security_group.tasks.id
    database = aws_security_group.database.id
  }
}
