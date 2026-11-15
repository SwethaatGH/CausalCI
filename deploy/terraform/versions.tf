terraform {
  required_version = ">= 1.6"
  required_providers {
    google      = { source = "hashicorp/google", version = "~> 6.14" }
    google-beta = { source = "hashicorp/google-beta", version = "~> 6.14" }
    helm        = { source = "hashicorp/helm", version = "~> 2.16" }
    kubernetes  = { source = "hashicorp/kubernetes", version = "~> 2.35" }
  }
}
