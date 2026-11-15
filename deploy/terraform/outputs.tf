output "cluster_name" {
  value = google_container_cluster.main.name
}

output "get_credentials" {
  value = "gcloud container clusters get-credentials ${google_container_cluster.main.name} --region ${var.region} --project ${var.project_id}"
}
