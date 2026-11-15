variable "project_id" {
  type        = string
  description = "GCP project to deploy into"
}

variable "region" {
  type    = string
  default = "us-east1"
}

variable "cluster_name" {
  type    = string
  default = "causalci"
}

variable "image_owner" {
  type        = string
  description = "GHCR owner for ghcr.io/<owner>/causalci-api and -worker"
}

variable "image_tag" {
  type    = string
  default = "latest"
}

variable "sandbox_max_nodes" {
  type        = number
  default     = 4
  description = "Upper bound for the gVisor node pool that runs untrusted test suites"
}

variable "gemini_api_key" {
  type      = string
  default   = ""
  sensitive = true
}

variable "github_token" {
  type      = string
  default   = ""
  sensitive = true
}

variable "jobs_token" {
  type        = string
  sensitive   = true
  description = "Bearer token required to create bisect jobs"
}
