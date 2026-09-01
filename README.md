# swarm-deploy

Swarm-based P2P architecture for securely uploading binaries.

Client seeds identify uploaders. Two active swarms sharing a client seed
present the same Hyperswarm identity, so Hyperswarm retains one transport to a
server at a time. Use distinct client seeds for concurrent uploads.
