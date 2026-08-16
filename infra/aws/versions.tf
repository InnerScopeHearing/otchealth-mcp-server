terraform {
  required_version = ">= 1.5.0" # >=1.5 for native `import {}` blocks, though this repo ships import.sh instead

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.60"
    }
  }
}
