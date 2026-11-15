# GKE cluster with two node pools:
#   system  — API, workers, Redis, KEDA
#   sandbox — GKE Sandbox (gVisor) nodes; only sandbox pods (RuntimeClass "gvisor") land here,
#             so untrusted test suites never share a kernel with the control services.
provider "google" {
  project = var.project_id
  region  = var.region
}

# GKE Sandbox (sandbox_config) is only exposed by the beta provider.
provider "google-beta" {
  project = var.project_id
  region  = var.region
}

data "google_client_config" "current" {}

resource "google_container_cluster" "main" {
  name                     = var.cluster_name
  location                 = var.region
  remove_default_node_pool = true
  initial_node_count       = 1
  deletion_protection      = false

  networking_mode = "VPC_NATIVE"
  ip_allocation_policy {}

  # Dataplane V2 (Cilium) enforces NetworkPolicy, including the sandbox egress rules.
  datapath_provider = "ADVANCED_DATAPATH"

  workload_identity_config {
    workload_pool = "${var.project_id}.svc.id.goog"
  }

  release_channel {
    channel = "REGULAR"
  }
}

resource "google_container_node_pool" "system" {
  name     = "system"
  cluster  = google_container_cluster.main.id
  location = var.region

  autoscaling {
    min_node_count = 1
    max_node_count = 3
  }

  node_config {
    machine_type = "e2-standard-2"
    disk_size_gb = 50
    oauth_scopes = ["https://www.googleapis.com/auth/cloud-platform"]
    workload_metadata_config { mode = "GKE_METADATA" }
    shielded_instance_config { enable_secure_boot = true }
  }
}

resource "google_container_node_pool" "sandbox" {
  provider = google-beta
  name     = "sandbox"
  cluster  = google_container_cluster.main.id
  location = var.region

  autoscaling {
    min_node_count = 0
    max_node_count = var.sandbox_max_nodes
  }

  node_config {
    machine_type = "e2-standard-4"
    image_type   = "COS_CONTAINERD"
    disk_size_gb = 100
    oauth_scopes = ["https://www.googleapis.com/auth/cloud-platform"]
    sandbox_config { sandbox_type = "gvisor" }
    workload_metadata_config { mode = "GKE_METADATA" }
    shielded_instance_config { enable_secure_boot = true }
  }
}

provider "kubernetes" {
  host                   = "https://${google_container_cluster.main.endpoint}"
  token                  = data.google_client_config.current.access_token
  cluster_ca_certificate = base64decode(google_container_cluster.main.master_auth[0].cluster_ca_certificate)
}

provider "helm" {
  kubernetes {
    host                   = "https://${google_container_cluster.main.endpoint}"
    token                  = data.google_client_config.current.access_token
    cluster_ca_certificate = base64decode(google_container_cluster.main.master_auth[0].cluster_ca_certificate)
  }
}

resource "kubernetes_namespace" "causalci" {
  metadata { name = "causalci" }
  depends_on = [google_container_node_pool.system]
}

resource "kubernetes_secret" "causalci" {
  metadata {
    name      = "causalci-secrets"
    namespace = kubernetes_namespace.causalci.metadata[0].name
  }
  data = {
    GEMINI_API_KEY = var.gemini_api_key
    GITHUB_TOKEN   = var.github_token
    JOBS_TOKEN     = var.jobs_token
  }
}

resource "helm_release" "keda" {
  name             = "keda"
  repository       = "https://kedacore.github.io/charts"
  chart            = "keda"
  version          = "2.16.1"
  namespace        = "keda"
  create_namespace = true
  depends_on       = [google_container_node_pool.system]
}

resource "helm_release" "causalci" {
  name      = "causalci"
  chart     = "${path.module}/../helm/causalci"
  namespace = kubernetes_namespace.causalci.metadata[0].name

  values = [yamlencode({
    image = {
      api    = "ghcr.io/${var.image_owner}/causalci-api"
      worker = "ghcr.io/${var.image_owner}/causalci-worker"
      tag    = var.image_tag
    }
    # GKE Sandbox provides the "gvisor" RuntimeClass itself.
    sandbox = { runtimeClassName = "gvisor", createRuntimeClass = false }
    keda    = { enabled = true }
  })]

  depends_on = [helm_release.keda, kubernetes_secret.causalci, google_container_node_pool.sandbox]
}
