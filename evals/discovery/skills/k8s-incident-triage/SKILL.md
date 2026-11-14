---
name: k8s-incident-triage
description: Triage a failing Kubernetes workload: crash loops, pending pods, failed rollouts and node pressure. Use when a deployment is unhealthy in a cluster.
---
# Triage Kubernetes incidents

Run kubectl describe and logs --previous, check events, resource limits and recent rollouts, then propose a rollback or fix.
