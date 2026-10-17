import type { Db } from '../db/sql'

// The instance's delivery and fetch policy by host (VIS-30): whether Kopje sends nothing to `host`, a normalized
// domain (hostDomain). The send-time check (deliveries.ts sendRefused) reads it for a row's inbox host and for each
// recipient host its provenance lists. Instance domain blocks fill it in (phase B2a); until then it refuses no host.
export function hostRefused(db: Db, host: string): boolean {
	return testPolicy?.(db, host) ?? false
}

let testPolicy: ((db: Db, host: string) => boolean) | null = null

// Tests only: stands in for the policy B2a defines, so the send-time check can be exercised before it exists. null
// restores the default.
export function setHostPolicyForTests(policy: ((db: Db, host: string) => boolean) | null): void {
	testPolicy = policy
}
