# HivePoA Compute Protocol Schemas

**Version:** 2
**Status:** Canonical — these are the source of truth for both repos

## Schema Files

| File | Description |
|------|-------------|
| `provenance_v2.json` | Provenance metadata (required on every job result) |
| `artifact_ref.json` | Content-addressed artifact reference (CID + SHA-256 + size) |
| `manifest_eval_sweep.json` | Eval sweep job manifest |
| `manifest_data_generation.json` | Data generation job manifest |
| `manifest_domain_lora_train.json` | LoRA training job manifest |
| `result_eval_sweep.json` | Eval sweep result contract |
| `result_data_generation.json` | Data generation result contract |
| `result_domain_lora_train.json` | LoRA training result contract |
| `baseline_registry_entry.json` | Immutable baseline registry record |
| `error_codes.json` | Machine-readable error codes for job failures |

## Versioning Policy

- `schema_version: 2` is the current protocol version
- **Additive changes** (new optional fields): bump patch, no worker update required
- **Breaking changes** (new required fields, removed fields, type changes): bump `schema_version` to 3, workers must update
- Workers MAY accept manifests with unknown optional fields (forward compatibility)
- Workers MUST reject manifests with `schema_version > supported_version`
- Coordinator MUST reject results that do not validate against the current schema version

## Fixtures

The `fixtures/` directory contains valid and invalid samples for each schema.
Both repos (HivePoA TypeScript, Hive-AI Python) validate the same fixture corpus in CI.

- `fixtures/*_valid.json` — must pass schema validation
- `fixtures/*_invalid.json` — must fail schema validation

## Cross-Repo Conformance

CI on both repos runs the same validation:

**TypeScript (HivePoA):** Ajv strict mode against `schemas/*.json` with `fixtures/`
**Python (Hive-AI):** `jsonschema` or generated Pydantic models against same fixtures

If a fixture passes in one repo but fails in the other, the protocol has drifted.
