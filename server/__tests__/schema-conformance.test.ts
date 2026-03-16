/**
 * Schema Conformance Tests
 *
 * Validates that canonical JSON Schema files in schemas/ correctly
 * accept valid fixtures and reject invalid fixtures.
 *
 * This is the TypeScript side of the cross-repo conformance check.
 * The Python side (Hive-AI repo) must validate the same fixture corpus.
 * If a fixture passes here but fails in Python (or vice versa), the protocol has drifted.
 */
import { describe, it, expect } from "vitest";
import Ajv2020 from "ajv/dist/2020";
import addFormats from "ajv-formats";
import * as fs from "fs";
import * as path from "path";

const SCHEMAS_DIR = path.resolve(__dirname, "../../schemas");
const FIXTURES_DIR = path.resolve(__dirname, "../../schemas/fixtures");

function loadJson(filePath: string): any {
  return JSON.parse(fs.readFileSync(filePath, "utf-8"));
}

function compileSchema(schema: any) {
  const ajv = new Ajv2020({ strict: true, allErrors: true });
  addFormats(ajv);
  return ajv.compile(schema);
}

// Schema file → fixture base name mapping
const SCHEMA_FIXTURE_MAP: Record<string, string> = {
  "provenance_v2.json": "provenance",
  "manifest_eval_sweep.json": "manifest_eval_sweep",
  "manifest_data_generation.json": "manifest_data_generation",
  "manifest_domain_lora_train.json": "manifest_domain_lora_train",
  "result_eval_sweep.json": "result_eval_sweep",
  "result_data_generation.json": "result_data_generation",
};

describe("Schema Conformance — Canonical JSON Schema Validation", () => {
  // Each test compiles its own schema to avoid Ajv duplicate-id errors

  // Test that all schema files parse and compile
  it("all schema files are valid JSON Schema 2020-12", () => {
    const schemaFiles = fs.readdirSync(SCHEMAS_DIR).filter(f => f.endsWith(".json"));
    expect(schemaFiles.length).toBeGreaterThanOrEqual(8);

    for (const file of schemaFiles) {
      const schema = loadJson(path.join(SCHEMAS_DIR, file));
      expect(() => compileSchema(schema)).not.toThrow();
    }
  });

  // For each schema with fixtures, test valid + invalid
  for (const [schemaFile, fixtureBase] of Object.entries(SCHEMA_FIXTURE_MAP)) {
    const validFixture = path.join(FIXTURES_DIR, `${fixtureBase}_valid.json`);
    const invalidFixture = path.join(FIXTURES_DIR, `${fixtureBase}_invalid.json`);

    describe(`${schemaFile}`, () => {
      it(`accepts ${fixtureBase}_valid.json`, () => {
        const schema = loadJson(path.join(SCHEMAS_DIR, schemaFile));
        const fixture = loadJson(validFixture);
        const validate = compileSchema(schema);
        const valid = validate(fixture);
        if (!valid) {
          console.error(`Validation errors for ${fixtureBase}_valid.json:`, validate.errors);
        }
        expect(valid).toBe(true);
      });

      it(`rejects ${fixtureBase}_invalid.json`, () => {
        const schema = loadJson(path.join(SCHEMAS_DIR, schemaFile));
        const fixture = loadJson(invalidFixture);
        // Remove the _reason field (it's documentation, not data)
        delete fixture._reason;
        const validate = compileSchema(schema);
        const valid = validate(fixture);
        expect(valid).toBe(false);
      });
    });
  }
});

describe("Schema Conformance — Artifact Ref", () => {
  // Each test compiles its own schema to avoid Ajv duplicate-id errors

  it("accepts valid artifact ref", () => {
    const schema = loadJson(path.join(SCHEMAS_DIR, "artifact_ref.json"));
    const validate = compileSchema(schema);
    expect(validate({
      output_cid: "QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG",
      output_sha256: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      output_size_bytes: 1048576,
    })).toBe(true);
  });

  it("rejects artifact ref with bad sha256", () => {
    const schema = loadJson(path.join(SCHEMAS_DIR, "artifact_ref.json"));
    const validate = compileSchema(schema);
    expect(validate({
      output_cid: "QmTest",
      output_sha256: "not-a-sha256",
      output_size_bytes: 100,
    })).toBe(false);
  });

  it("rejects artifact ref with missing fields", () => {
    const schema = loadJson(path.join(SCHEMAS_DIR, "artifact_ref.json"));
    const validate = compileSchema(schema);
    expect(validate({ output_cid: "QmTest" })).toBe(false);
  });
});

describe("Schema Conformance — Error Codes", () => {
  // Each test compiles its own schema to avoid Ajv duplicate-id errors

  it("accepts valid error code", () => {
    const schema = loadJson(path.join(SCHEMAS_DIR, "error_codes.json"));
    const validate = compileSchema(schema);
    expect(validate({
      error_code: "JOB_NONCE_MISMATCH",
      error_message: "The job_nonce in the result does not match the manifest",
    })).toBe(true);
  });

  it("rejects unknown error code", () => {
    const schema = loadJson(path.join(SCHEMAS_DIR, "error_codes.json"));
    const validate = compileSchema(schema);
    expect(validate({
      error_code: "MADE_UP_ERROR",
    })).toBe(false);
  });
});

describe("Schema Conformance — Baseline Registry", () => {
  // Each test compiles its own schema to avoid Ajv duplicate-id errors

  it("accepts valid baseline registry entry", () => {
    const schema = loadJson(path.join(SCHEMAS_DIR, "baseline_registry_entry.json"));
    const validate = compileSchema(schema);
    expect(validate({
      version: "v6",
      parent_version: "v5",
      merged_at: "2026-04-01T12:00:00Z",
      contributing_job_ids: ["job-1", "job-2"],
      contributing_workers: ["worker-a"],
      dataset_cids: ["QmAbc"],
      merge_algorithm: "dense_delta_svd",
      merge_rank: 32,
      discarded_residual_norm: 0.023,
      eval_scores: { "python": 0.94, "rust": 0.96 },
      overall_score: 0.945,
      baseline_improvement: 0.012,
      adapter_cid: "QmMerged",
      adapter_sha256: "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    })).toBe(true);
  });

  it("rejects entry with invalid merge algorithm", () => {
    const schema = loadJson(path.join(SCHEMAS_DIR, "baseline_registry_entry.json"));
    const validate = compileSchema(schema);
    expect(validate({
      version: "v6",
      merged_at: "2026-04-01T12:00:00Z",
      contributing_job_ids: ["job-1"],
      merge_algorithm: "magic_merge",
      merge_rank: 32,
      eval_scores: {},
      overall_score: 0.9,
      adapter_cid: "QmTest",
      adapter_sha256: "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    })).toBe(false);
  });
});
