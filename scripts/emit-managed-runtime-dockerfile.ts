#!/usr/bin/env bun

import { buildManagedRuntimeDockerfile } from '../src/init/managed-runtime-dockerfile'

const version = process.argv[2]
if (version === undefined) {
  console.error('usage: emit-managed-runtime-dockerfile.ts <x.y.z> [base-image-repository]')
  process.exit(2)
}

const baseImageRepository = process.argv[3]
process.stdout.write(
  buildManagedRuntimeDockerfile({
    baseImageVersion: version,
    ...(baseImageRepository !== undefined ? { baseImageRepository } : {}),
  }),
)
